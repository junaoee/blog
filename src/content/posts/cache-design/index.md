---
title: 缓存设计：穿透、击穿、雪崩与一致性
description: 加一层缓存容易，难的是知道它什么时候会坏。这篇讲三种典型缓存故障、缓存与数据库的一致性策略、分布式锁的正确用法，以及本地缓存和分布式缓存怎么配合。
pubDate: 2026-10-12
tags: ['后端', '缓存']
---

缓存是后端性价比最高的优化 —— 加一层缓存，P99 延迟能从 800ms 降到 8ms。

但缓存也是后端最常见的故障源。问题几乎总是同一个：**缓存和数据库对不上的时候，系统会怎样**。

## 先理解 Redis 的位置

```text
用户请求
   ↓
[本地缓存]  ← 最快，微秒级，但每个进程一份
   ↓ 未命中
[Redis]     ← 次快，毫秒级，全局共享
   ↓ 未命中
[数据库]    ← 最慢，但唯一真相来源
```

三层各有各的问题，本地缓存的一致性尤其麻烦。后面单独讲。

## 缓存穿透：查不存在的数据

**现象**：请求一个数据库里根本没有的数据。

```python
def get_user(user_id: int):
    key = f"user:{user_id}"
    data = redis.get(key)

    if data is None:
        data = db.query(User, user_id)      # 每次都查库，永远返回 None

        if data:
            redis.setex(key, 3600, serialize(data))

    return data       # 永远是 None
```

**问题**：恶意用户用随机 ID 疯狂请求，每次都穿透到数据库。数据库本身没压力，但正常请求被挤占了。

**解法：缓存空值**

```python
def get_user(user_id: int):
    key = f"user:{user_id}"
    cached = redis.get(key)

    if cached is not None:
        # 特殊标记：负缓存
        return None if cached == b'__NULL__' else deserialize(cached)

    data = db.query(User, user_id)

    if data:
        redis.setex(key, 3600, serialize(data))
    else:
        # 空结果也缓存，但 TTL 要短
        redis.setex(key, 60, b'__NULL__')

    return data
```

TTL 设短是关键 —— 数据可能几分钟后就有了，缓存 60 秒足够挡住穿透流量，又不会让负缓存太陈旧。

**另一种解法：布隆过滤器**

如果 ID 是自增整数、或者你能提前拿到所有合法 ID，用布隆过滤器挡在前面：

```python
class BloomFilter:
    def __init__(self, size_bits: int, num_hashes: int):
        self.size = size_bits
        self.num_hashes = num_hashes
        self.bits = bytearray(size_bits // 8)

    def _hashes(self, item: str):
        h1 = hashlib.md5(item.encode()).digest()
        h2 = hashlib.sha1(item.encode()).digest()
        for i in range(self.num_hashes):
            yield (int.from_bytes(h1[i % 16:i % 16 + 4], 'big') % self.size
                   + int.from_bytes(h2[i % 16:i % 16 + 4], 'big')) % self.size

    def add(self, item: str):
        for h in self._hashes(item):
            self.bits[h // 8] |= 1 << (h % 8)

    def might_contain(self, item: str) -> bool:
        return all(self.bits[h // 8] & (1 << (h % 8)) for h in self._hashes(item))
```

布隆过滤器的特性：**说「可能有」时可能有 1% 的概率没有，但说「没有」时一定没有**。所以用来做否定判断是安全的，用来肯定判断则要继续查数据库。

不适合的场景是数据频繁变化的场景 —— 过滤器要跟着更新。

## 缓存击穿：某个热点 key 过期

**现象**：一个被大量请求的 key 恰好过期，瞬时几百个请求同时打到数据库。

**解法一：互斥锁**

```python
def get_hot_article(article_id: int):
    key = f"article:{article_id}"
    data = redis.get(key)

    if data:
        return data

    # 只让一个线程去重建缓存
    lock_key = f"lock:{key}"
    acquired = redis.set(lock_key, 1, nx=True, ex=10)

    if acquired:
        try:
            # 拿到锁的线程去查库
            data = db.query(Article, article_id)
            if data:
                redis.setex(key, 3600, serialize(data))
            return data
        finally:
            redis.delete(lock_key)
    else:
        # 没拿到锁的线程短暂等待后重试
        # 此时第一个线程很可能已经重建好了
        time.sleep(0.05)
        return redis.get(key) or get_hot_article(article_id)
```

注意锁的 `ex=10`：必须有过期时间，否则持锁的进程崩溃后会**死锁**，所有请求永久卡住。

**解法二：逻辑过期**（更优雅）

缓存值里存一个「逻辑过期时间」，过期了也不真的删，而是返回旧值同时异步重建：

```python
def get_hot_article(article_id: int):
    key = f"article:{article_id}"
    raw = redis.get(key)

    if raw is None:
        return rebuild_and_return(key, article_id)

    entry = json.loads(raw)

    if entry['expired_at'] > time.time():
        return entry['data']          # 未过期，正常返回

    # 已逻辑过期：返回旧数据，同时异步重建
    rebuild_async(key, article_id)   # 丢进线程池，不阻塞
    return entry['data']             # 用户永远不等待
```

**解法三：永不过期 + 后台刷新**

适合数据变化不频繁、且必须保证可用性的数据。定时任务主动刷新，缓存本身不过期。

## 缓存雪崩：大量 key 同时过期

**现象**：缓存批量预热时设置了相同 TTL，成千上万个 key 在同一秒集体失效，数据库瞬间被压垮。

**解法一：TTL 加随机抖动**

```python
import random

def set_cache(key: str, value: str, base_ttl: int = 3600):
    # 基础 TTL 加 0–300 秒随机值
    ttl = base_ttl + random.randint(0, 300)
    redis.setex(key, ttl, value)
```

这个改动的效果：**过期时间被打散到 5 分钟的窗口里**，不会有大批 key 同时失效。

**解法二：Redis 高可用 + 本地缓存兜底**

Redis 主从切换或集群故障时，本地缓存还能撑一段时间。

**解法三：熔断降级**

缓存完全挂掉时，直接返回数据库的结果（哪怕慢），而不是让请求全部失败。

```python
class CircuitBreaker:
    def __init__(self, threshold: int = 10, reset_after: int = 30):
        self.failures = 0
        self.threshold = threshold
        self.reset_after = reset_after
        self.opened_at = None

    def allow(self) -> bool:
        if self.opened_at is None:
            return True
        if time.time() - self.opened_at > self.reset_after:
            self.failures = 0        # 冷却结束，半开状态
            self.opened_at = None
            return True
        return False                 # 熔断中

    def record_success(self):
        self.failures = 0
        self.opened_at = None

    def record_failure(self):
        self.failures += 1
        if self.failures >= self.threshold:
            self.opened_at = time.time()
```

## 缓存一致性：最难的部分

先说结论：**缓存和数据库的强一致性，在分布式环境下基本做不到。** 不要假装能做到。

剩下的问题是：能做到什么程度，以及不一致的窗口有多小。

### 策略一：Cache Aside（最常用）

```python
def update_user(user_id: int, data: dict):
    # 1. 先更新数据库
    db.update(User, user_id, **data)

    # 2. 再删除缓存
    redis.delete(f"user:{user_id}")
```

**为什么是「更新库 → 删缓存」，不是反过来？**

如果先删缓存再更新库，中间有一个窗口，别的请求会读到旧库的数据然后把旧值写回缓存 —— 之后缓存里就是脏数据，而且会一直脏到 TTL 过期。

而先更新库再删缓存，最坏情况是别的请求在两步之间读了旧库值，缓存里存了旧值，但**下一次删缓存操作会把它清掉**。不一致窗口更短。

> [!WARNING]
> Cache Aside 有一致性问题：删缓存之后、下次读缓存之前，如果有人更新了库并删了缓存，然后有个更早的读请求把旧值写回了缓存，就会脏。更稳的做法是延迟双删，或用消息队列串行化。

**更稳的写法：延迟双删**

```python
def update_user(user_id: int, data: dict):
    db.update(User, user_id, **data)
    redis.delete(f"user:{user_id}")

    # 延迟再删一次，清理可能写回的旧值
    schedule_in(0.5, lambda: redis.delete(f"user:{user_id}"))
```

第二次删除是为了处理「更新库之后、删缓存之前，有并发读把旧值写回」这个窗口。

### 策略二：先删缓存，更新库，再删缓存

这是在分布式环境下被验证过更稳的顺序：

```text
1. 删除缓存
2. 更新数据库
3. 再次删除缓存
```

**先删**能尽早让后续读请求去读库（拿到即将更新的新值），第二次删兜底清理。这个顺序比 Cache Aside 的不一致窗口更小。

### 策略三：订阅 binlog（更可靠）

用 Canal、Debezium 或云厂商的 binlog 工具订阅数据库变更事件，异步失效缓存。

```python
class CacheInvalidator:
    def on_binlog_event(self, event):
        table = event.table
        if table not in INVALIDATE_TABLES:
            return

        for row in event.rows:
            # 拿到主键，构造缓存 key
            key = f"{CACHE_KEY_PREFIX[table]}:{row['id']}"

            if event.op == 'UPDATE':
                # 有变更就删，让下次读重新加载
                redis.delete(key)
            elif event.op == 'DELETE':
                redis.delete(key)
            elif event.op == 'INSERT':
                redis.delete(key)
```

好处是**应用代码完全不用关心缓存失效**，改库的代码自然就生效了。这比在每个 update 方法里手写 `redis.delete` 可靠得多 —— 手写总会有人忘。

### 哪些数据不该放缓存

- **强一致性要求的数据**：余额、库存、优惠券状态 —— 算错要出事故
- **变化极快的数据**：秒杀计数器、实时排名
- **本身就很快的数据**：小表、配置项 —— 查库可能只要 1ms，加缓存反而多一跳

## 本地缓存：快，但难搞

Redis 再快也有网络往返（同城约 0.5–1ms）。用进程内的字典做二级缓存，能省掉这一跳。

但麻烦在于**失效**：删了 Redis，本地缓存不知道，还会继续返回旧数据。

### 广播失效

```python
# 每个实例订阅失效频道
class LocalCache:
    def __init__(self, instance_id: str):
        self.instance_id = instance_id
        self.cache = {}
        self.lock = threading.RLock()

        # 订阅失效消息（发布订阅而非队列，任何实例发都所有实例收）
        self.pubsub = redis.pubsub()
        self.pubsub.subscribe('cache:invalidate')
        threading.Thread(target=self._listen, daemon=True).start()

    def _listen(self):
        for message in self.pubsub.listen():
            if message['type'] != 'message':
                continue

            key = message['data'].decode()
            with self.lock:
                self.cache.pop(key, None)

    def get(self, key: str):
        with self.lock:
            return self.cache.get(key)

    def set(self, key: str, value, ttl: int = 300):
        with self.lock:
            self.cache[key] = (value, time.time() + ttl)

    def invalidate(self, key: str):
        # 先删 Redis（全局）
        redis.delete(key)
        # 再广播，让所有实例删本地
        redis.publish('cache:invalidate', key)
```

注意：**必须先删 Redis 再广播**。反过来会出现「A 实例删了本地并广播，但 Redis 还没删，B 实例收到广播删了本地，然后 C 实例读缓存未命中去查 Redis 又拿到旧值写回本地」的竞态。

**本地缓存的 TTL 要短**（30–60 秒），这样即使失效消息丢了，也能自动恢复一致。

### 什么时候值得

- QPS 极高，且延迟预算很紧（要求 P99 < 5ms）
- 数据变化不频繁
- 实例数不多（几十个以内）

实例数上千时，广播消息本身会成为瓶颈，得不偿失。

## 分布式锁的几个坑

用 Redis 做分布式锁，**没有绝对安全的实现**。但有几个必须注意的点。

```python
def acquire_lock(lock_key: str, owner: str, ttl: int = 30) -> bool:
    # NX：只在不存在时设置
    ok = redis.set(lock_key, owner, nx=True, ex=ttl)
    return bool(ok)
```

**坑 1：必须用 `SET NX EX`，不能分开写**

```python
# ❌ 两步之间有竞态，两个进程都可能认为自己拿到了锁
if redis.exists(lock_key) == 0:
    redis.set(lock_key, owner, ex=ttl)

# ✅ 原子操作
redis.set(lock_key, owner, nx=True, ex=ttl)
```

**坑 2：必须校验持有者再释放**

```python
# ❌ 自己的锁可能已经超时被别人拿走了，这行会删掉别人的锁
redis.delete(lock_key)

# ✅ Lua 脚本保证「检查」和「删除」是原子的
RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""

def release_lock(lock_key: str, owner: str):
    redis.eval(RELEASE_SCRIPT, 1, lock_key, owner)
```

**坑 3：TTL 必须大于业务执行时间**

否则业务还没跑完锁就过期了，第二个进程拿到锁，两个同时执行 —— 锁就白加了。

如果无法预估业务耗时，可以**看门狗续期**：

```python
class LockWatchdog:
    def __init__(self, lock_key: str, owner: str):
        self.lock_key = lock_key
        self.owner = owner
        self.running = False

    def start(self):
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while self.running:
            # 每 10 秒续期到 30 秒
            redis.eval(RENEW_SCRIPT, 1, self.lock_key, self.owner)
            time.sleep(10)

    def stop(self):
        self.running = False
        release_lock(self.lock_key, self.owner)
```

**什么时候不该用分布式锁**

如果业务本身能用数据库约束或唯一索引保证正确性，就别用分布式锁 —— 少一个组件少一份风险。

比如「同一用户只能有一个进行中的订单」，与其加锁，不如在数据库加部分唯一索引。

## 缓存的度量

没有监控的缓存是黑盒，出问题都不知道从哪查。

**至少盯这几个指标**：

| 指标 | 含义 | 异常信号 |
| --- | --- | --- |
| `hit_rate` | 命中率 | 突然下降说明有大量未命中 |
| `evicted_keys` | 被淘汰的键数 | 内存不足的信号 |
| `used_memory` | 内存占用 | 接近上限要出事 |
| `keyspace_misses` | 未命中次数 | 配合命中率一起看 |

命中率的健康值：

- **90% 以上**：良好
- **70–90%**：正常但有优化空间
- **低于 70%**：要么缓存了不该缓存的东西，要么 TTL 设置有问题

**命中率不是越高越好**。如果命中率 99.99%，说明缓存了本不该缓存的数据（比如用户权限这种强一致数据），那是有风险的。

常用命令：

```bash
INFO stats | grep keyspace_hits
INFO stats | grep keyspace_misses

# 命中率
redis-cli INFO stats | python3 -c "
import sys
hits = misses = 0
for line in sys.stdin:
    if 'keyspace_hits' in line: hits = int(line.split(':')[1])
    if 'keyspace_misses' in line: misses = int(line.split(':')[1])
total = hits + misses
print(f'命中率: {hits/total*100:.2f}%' if total else '无数据')
"
```

## 一份排查清单

线上出问题时按这个顺序查：

- [ ] 命中率是否异常下降？用 `MONITOR` 或慢日志看是不是有异常 key
- [ ] 是否有大量 key 同时过期？看 TTL 分布
- [ ] 数据库 QPS 是否同步飙升？是的话基本就是缓存失效了
- [ ] Redis 内存是否接近上限？`INFO memory` 看 `used_memory` 和 `maxmemory`
- [ ] 是否有大批量写入导致缓存被逐出？
- [ ] 本地缓存和 Redis 是否不一致？消息是否丢失？

最后一条最隐蔽 —— 如果用了本地缓存 + 广播失效，一定要有 TTL 兜底，**不要假设广播一定送达**。网络会抖，订阅会断。