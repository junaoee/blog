---
title: 数据库选型与索引设计
description: 关系型、文档型、KV 存储怎么选；索引为什么快；最左前缀、覆盖索引、回表这些概念到底怎么回事。这篇把后端最容易踩的性能坑讲透。
pubDate: 2026-10-13
tags: ['后端', '数据库']
---

数据库是后端性能问题的主要来源。业务代码写得再优雅，一条没走索引的查询就能让整站卡住。

这篇分三部分：选型、索引原理、实际排查。

## 选型：先问数据长什么样

技术选型的常见错误，是从「哪个数据库更先进」开始问。正确顺序是先搞清楚数据的形状。

### 关系型数据库（PostgreSQL、MySQL）

适合**结构稳定、关系复杂、需要事务**的场景。

PostgreSQL 尤其被低估，它能当关系库用，也能当文档库、时序库、地理库用，很多团队到后期才发现当初不需要引入额外的数据库。

**什么时候该选它**：订单、用户、账目 —— 任何「钱和数量算错要出事」的地方。ACID 事务不是可选项。

### 文档数据库（MongoDB）

适合**结构多变、按文档整体读写**的场景。

典型的成功案例是日志和事件存储：字段经常变、几乎只按时间范围查、很少做多表关联。

**失败案例**是把关系型的数据塞进去然后写一堆 `$lookup` 聚合 —— 文档库没帮你省事，反而失去了关系库的能力。

### KV 存储（Redis、etcd）

两类用途完全不同：

- **Redis** 是内存缓存，快的代价是数据在特定情况下会丢
- **etcd** 是分布式协调存储，强一致、持久化，但吞吐远不如 Redis

别把 etcd 当缓存用，也别把 Redis 当共识存储用。

### 一个务实的原则

**能用一种数据库解决的，不要引入第二种。** 每多一种数据库，就多一份运维成本、一份备份策略、一份监控、一套故障预案。很多团队同时维护 MySQL、Redis、MongoDB、ES，最后 P99 延迟的问题排查了半天，发现是某个冷门的数据源没连接池上限。

先把关系库用好，它能承接绝大多数业务。

## B+ 树：索引为什么快

理解索引，先理解数据结构。

关系型数据库的索引几乎都是 B+ 树。这个结构的关键特性是：

```text
                [50]
               /    \
        [10,20,30]   [70,80,90]     ← 非叶子节点只存索引
          /   \        /   \
      [1..9] [21..29] [71..79] [91..99]   ← 叶子节点存数据
        ↖ 链表相连，可以顺序扫描 ↗
```

对比二叉查找树：

| | B+ 树 | 二叉查找树 |
| --- | --- | --- |
| 树高 | 百万级数据约 3–4 层 | 可能退化到上千层 |
| 磁盘 IO | 每层 1 次 | 每层 1 次 |
| 范围查询 | 叶子链表直接扫 | 需要回溯整棵树 |

**B+ 树的层数之所以低**，是因为它的分支因子极大（几百到上千）。假设每页能放 500 个索引项，一棵三层的 B+ 树能容纳 $500^3 = 1.25 \times 10^8$ 条记录。

查一条记录：读一次根节点 → 读一次中间节点 → 读一次叶子节点。**固定 3 次磁盘 IO**，与数据量无关。这就是为什么索引能把千万级的查询压到几毫秒。

> [!NOTE]
> 树高会随数据量缓慢增长，但增长的是对数。数据量翻 100 倍，树高只增加 1 层左右。

## 最左前缀原则

这是复合索引里最容易搞错的规则。

假设有复合索引：

```sql
CREATE INDEX idx_user_time ON orders (user_id, created_at);
```

**索引在数据库内部是这个顺序排列的：**

```
(user_id=1, created_at=2024-01-01)
(user_id=1, created_at=2024-06-01)
(user_id=1, created_at=2025-01-01)
(user_id=2, created_at=2024-03-01)
(user_id=2, created_at=2024-09-01)
(user_id=3, created_at=2025-02-01)
...
```

注意：**先按 `user_id` 排，同一个 `user_id` 内部再按 `created_at` 排。**

于是：

```sql
-- ✅ 用上了：user_id 是索引第一列，能定位
WHERE user_id = 1 AND created_at > '2025-01-01'

-- ✅ 用上了：只查第一列也能用
WHERE user_id = 1

-- ❌ 用不上：created_at 单独查时，索引里是乱序的
WHERE created_at > '2025-01-01'
```

第三条为什么不行？因为索引里 `created_at` 的值是 `2024-01-01, 2024-06-01, 2025-01-01, 2024-03-01...` —— 跨 `user_id` 重复且不连续，数据库没法用它做有序查找，只能全表扫描。

规则一句话：**能从索引最左列开始，连续、不间断地用到后面的列**。中间断了，后面就失效。

```sql
-- 索引 (a, b, c)
WHERE a = 1 AND c = 3        -- b 没用到，c 用不上
WHERE a = 1 AND b = 2 AND c = 3   -- ✅ 全都用上
WHERE b = 2 AND a = 1 AND c = 3   -- ✅ 顺序不影响（优化器会重排）
```

最后一条能用的原因：**SQL 里的书写顺序不影响索引使用**，优化器会自己重排。但**索引定义的列顺序**是有讲究的。

### 索引列顺序怎么定

按「区分度」从高到低排。区分度 = 该列不同值的数量 / 总行数。

```sql
-- status 只有 3 个值，区分度极低；user_id 千万人各不相同
-- ❌ 低区分度的列放前面
CREATE INDEX idx_bad ON orders (status, user_id);

-- ✅ 高区分度的列放前面
CREATE INDEX idx_good ON orders (user_id, status);
```

不过这条规则有个例外：**等值查询放前面，范围查询放最后**。

```sql
-- 查询：WHERE user_id = 1 AND created_at > '2025-01-01' ORDER BY created_at
-- ✅ 等值在前、范围在后，范围列还能顺带排序
CREATE INDEX idx ON orders (user_id, created_at);
```

原因是 B+ 树只能对**第一列**做有序定位。从第二列开始，如果前面的列没被完全固定，顺序就没意义了。

## 覆盖索引与回表

**回表**：通过索引找到主键值，再拿这个主键去聚簇索引里查完整的行数据。多一次 IO。

**覆盖索引**：查询需要的字段全部在索引里，不用回表。

```sql
-- 索引只含 (user_id, created_at)

-- 需要回表：还要取 amount
SELECT * FROM orders WHERE user_id = 1 AND created_at > '2025-01-01';

-- 覆盖索引：索引里就够了，不用回表
SELECT user_id, created_at FROM orders WHERE user_id = 1 AND created_at > '2025-01-01';
```

`SELECT *` 是回表的最大来源，因为它几乎必然需要索引外的字段。

覆盖索引需要额外存储，宽索引会显著增大数据库体积。**判断标准**：如果查询极热且返回字段少，加宽索引划算；如果是列表页要展示十几个字段，那不如直接回表。

MySQL 和 PostgreSQL 的执行计划里能看到 `Using index`（覆盖索引）和 `Using where`（需要额外过滤）。

## 索引不是越多越好

每加一个索引，写入就要多付一次成本。

```sql
INSERT INTO orders (user_id, created_at, amount) VALUES (...);
```

数据库要维护**每一个**包含被修改列的索引：主键索引、`idx_user_time`、可能还有 `idx_status`、`idx_merchant`…… 每个都是一次 B+ 树的插入和可能的页分裂。

**写多的表，索引要克制；读多的表，索引可以多一点。** 典型的写入密集表是日志、事件流、订单流水，这些表上 3 个索引以内通常就够了。

另一个常被忽略的代价：**索引会阻止某些数据库做某些优化**。比如 MySQL 在某些情况下选择全表扫描反而更快，因为顺序读磁盘的效率远高于随机 IO —— 加了不合适的索引，反而把顺序扫描变成了随机查找。

## 慢查询排查

出问题时的标准流程。

**第一步：找到慢查询日志**

```ini
# MySQL
slow_query_log = ON
long_query_time = 1        # 超过 1 秒记录
```

**第二步：用 EXPLAIN 看执行计划**

```sql
EXPLAIN ANALYZE
SELECT o.id, o.amount, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'paid'
  AND o.created_at > '2026-01-01'
ORDER BY o.created_at DESC
LIMIT 100;
```

关键看这几列：

| 字段 | 含义 | 危险信号 |
| --- | --- | --- |
| `type` | 访问类型 | `ALL` 是全表扫描；`index` 是全索引扫描 |
| `key` | 实际用的索引 | `NULL` 说明没用上索引 |
| `rows` | 预估扫描行数 | 和实际表行数同量级 → 索引失效 |
| `Extra` | 额外信息 | `Using filesort` / `Using temporary` 要警惕 |

`Using filesort` 意味着排序没走索引，数据库额外创建临时文件排序。数据量小无所谓，百万级以上就是性能杀手。

**第三步：对照实际数据量**

`EXPLAIN` 给的是**估算**。索引统计信息过期时，估算会离谱地错。

```sql
ANALYZE TABLE orders;   -- 更新统计信息
```

MySQL 8.0 的 `EXPLAIN ANALYZE` 会实际执行并给出真实行数，能直接看出估算偏差。

### 一个典型场景

```sql
-- 慢：8.2 秒
SELECT * FROM orders
WHERE DATE(created_at) = '2026-10-01'
  AND status = 'paid';
```

问题出在 `DATE(created_at)` —— **对索引列套函数会让索引失效**，因为 B+ 树存的是原始值，而函数计算后的值没法直接匹配。

改写成范围查询：

```sql
-- 快：12 毫秒
SELECT * FROM orders
WHERE created_at >= '2026-10-01 00:00:00'
  AND created_at <  '2026-10-02 00:00:00'
  AND status = 'paid';
```

这也是为什么日期条件要用**左闭右开**的半开区间：最后那个 `< '2026-10-02'` 而不是 `<= '2026-10-01 23:59:59'` —— 后者漏掉了当天最后一秒内带毫秒或微秒的数据。

同理，下面这些写法都会让索引失效：

```sql
WHERE YEAR(created_at) = 2026          -- 函数
WHERE created_at LIKE '%10%'           -- 前导通配符
WHERE name = 'abc' COLLATE xxx         -- 隐式类型转换
WHERE status = 1                       -- 列是 varchar 却传数字
```

**隐式类型转换**特别隐蔽：字段是 `VARCHAR`，你传了数字 `123`，数据库为了匹配会把**每一行**的字段转成数字再比较，索引直接失效。Java、Go、Python 这类动态语言不会在编译期拦你。

## 事务隔离级别

四个级别，按并发程度递减、正确性递增。

| 级别 | 脏读 | 不可重复读 | 幻读 | 说明 |
| --- | --- | --- | --- | --- |
| Read Uncommitted | 可能 | 可能 | 可能 | 基本不用 |
| Read Committed | 否 | 可能 | 可能 | PostgreSQL 默认 |
| Repeatable Read | 否 | 否 | 可能\* | MySQL 默认 |
| Serializable | 否 | 否 | 否 | 完全隔离 |

\* MySQL 的 InnoDB 在 RR 级别下通过间隙锁基本避免了幻读。

三个经典问题：

- **脏读**：读到别的事务还没提交的数据。对方一回滚，你读到的就是从未存在过的数据。
- **不可重复读**：同一事务内两次读同一行，结果不同（期间别人改了）。
- **幻读**：同一事务内两次范围查询，第二次多出了行（期间别人插入了）。

**Read Committed** 是很多团队的合理选择，它避免了脏读（最严重的问题），锁的持有时间也更短，并发更好。代价是需要应用层保证可重复读的场景（比如先查余额再扣减）用其他手段解决。

## 唯一约束应该由数据库保证

很多系统的「唯一性」是靠应用层先查一遍再插入：

```python
# ❌ 并发下会失效
if not db.exists(username=username):
    db.add(User(username=username))
    db.commit()
```

两个请求同时通过检查，然后都插入，产生重复。**这个 check-then-act 在并发下必然出问题。**

正确做法是让数据库用唯一约束兜底：

```sql
CREATE UNIQUE INDEX idx_username ON users (username);
```

```python
try:
    db.add(User(username=username))
    db.commit()
except IntegrityError:
    raise ConflictError("用户名已被占用")
```

**应用层检查可以用来给出友好提示，但不能作为唯一的保障。** 数据库约束是最后一道防线，且不会因为代码改动或并发时序而失效。

同样的道理适用于外键、检查约束、非空约束 —— 能交给数据库的，就别在应用里手写一遍。

## 事务里不要做慢操作

一个事务持有锁的时间越长，并发能力越差。

```python
# ❌ 事务里发 HTTP 请求，可能阻塞 3 秒
with db.begin():
    order = create_order(data)
    send_email(order.id)          # 网络 IO
    call_payment_gateway(data)    # 网络 IO
    db.commit()

# ✅ 先提交，再做慢操作
with db.begin():
    order = create_order(data)
    order.set_status('pending')

send_email(order.id)
call_payment_gateway(data)
```

上面这个改法还涉及另一个要点：**状态机**。不要让一个事务同时负责「建订单」和「支付」，拆成 `pending → paid → shipped` 的状态流转，每步独立事务。这样任何一步失败都能安全重试，状态也是可查询的。

## 连接池

每个数据库连接都是重量级资源（内存 + 文件描述符 + TCP 状态），必须复用。

```python
engine = create_engine(
    DATABASE_URL,
    pool_size=20,        # 常驻连接数
    max_overflow=10,     # 峰值时可临时开的连接
    pool_timeout=30,     # 等待连接的超时时间
    pool_recycle=3600,   # 连接存活时间，防止中间设备掐断
)
```

**`pool_recycle` 容易被忽略。** MySQL 默认 8 小时后主动断开连接（`wait_timeout`），如果你的连接池里有一条连接已经躺了 9 小时，下一次用它就会报「MySQL server has gone away」。定期回收能避免这个问题 —— 让连接比服务端的超时短就行。

连接池大小的经验值：CPU 核数 × 2 + 有效磁盘数。**不是越大越好**，数据库能同时处理的连接数有上限，连接池超过这个数只会让数据库更慢。

## 最后

排查顺序永远是这个顺序：

1. **先看是不是索引问题** —— `EXPLAIN` 看有没有走索引、`rows` 扫描了多少行
2. **再看是不是数据量问题** —— 同样的 SQL，数据量小的时候飞快
3. **最后看是不是代码问题** —— N+1 查询、循环里调接口、没批量处理

**90% 的数据库性能问题在第一步就能定位。** 别一上来就加机器，先看执行计划。