---
title: 消息队列与异步架构
description: MQ 到底解决什么问题，什么时候不该用它；可靠投递、消费幂等、顺序性、死信队列，以及本地消息表和事务消息这两条实现路径。
pubDate: 2026-10-11
tags: ['后端', '消息队列']
---

消息队列在后端的位置很尴尬：概念上都知道「解耦、削峰、异步」，但真到设计的时候，往往说不出具体解了什么耦、削了什么峰。

这篇从实际问题出发，讲清楚 MQ 的适用场景和实现细节。

## MQ 到底解决什么

### 解耦：把「同时知道」变成「只需要知道」

一个典型的反例。订单创建后要做五件事：扣库存、发通知、更新搜索索引、记账、风控检查。

```python
# ❌ 紧耦合
def create_order(data):
    order = db.insert(Order, data)

    inventory.deduct(order.id)      # 挂了，整个下单失败
    notify.send(order)              # 挂了，整个下单失败
    search.index(order)             # 挂了，整个下单失败
    ledger.write(order)             # 挂了，整个下单失败
    risk.check(order)               # 挂了，整个下单失败

    return order
```

这段代码有两个问题：**响应时间叠加**（五个服务串行），**可用性相乘**（每个服务 99.9% 可用，整条链路只剩 $0.999^5 = 99.5\%$）。

```python
# ✅ 松耦合
def create_order(data):
    order = db.insert(Order, data)
    mq.publish('order.created', order.to_dict())   # 只管发消息
    return order                                    # 立刻返回

# 五个消费者各自独立，互不影响
def handle_inventory(msg):
    inventory.deduct(msg['id'])

def handle_notify(msg):
    notify.send(msg)
```

响应时间从 5 个服务的总和降到「一次写库 + 一次发消息」。可用性从相乘变成相加：现在只有数据库是硬依赖。

**但要注意**：解耦的代价是**你失去了对流程的控制**。以前代码里能一眼看出「先扣库存再发货」，现在得在多个消费者之间追踪调用关系。所以队列要有清晰的命名和文档。

### 削峰：让生产者不必等消费者

秒杀场景：1 万件商品，10 万请求涌入。同步处理数据库只能扛住 500 QPS。

```python
# ❌ 数据库直接被打爆
def seckill(item_id, user_id):
    stock = redis.get(f'stock:{item_id}')
    if stock > 0:
        redis.decr(f'stock:{item_id}')
        create_order(item_id, user_id)
```

```python
# ✅ 入队即返回，DB 慢慢消费
def seckill(item_id, user_id):
    mq.publish('seckill.request', {'item_id': item_id, 'user_id': user_id})
    return {'code': 0, 'msg': '排队中'}

# 消费者按数据库能承受的速率消费
def consume_seckill(msg):
    # 内存扣减 + 异步写库（pipeline 批量）
    if redis.decr(f'stock:{msg["item_id"]}') > 0:
        orders_buffer.append(msg)
```

峰值流量进了队列，消费者按自己的节奏处理。**队列在这里扮演了缓冲区**。

> [!NOTE]
> 削峰不只是「保护数据库」。更重要的是**用户体验可控** —— 用户看到的是「排队中，第 1234 位」，比页面转圈 30 秒后报错好得多。

### 异步：把非必要的工作挪出主流程

有些工作用户根本不需要等结果：

- 发短信、邮件、推送
- 数据同步到数仓
- 生成报表
- 图片缩略图处理

这些放进队列，主流程只返回必要结果。

## 什么时候不该用 MQ

MQ 不是银弹，用错地方反而更糟。

**1. 流程简单、调用方少的时候**

就两个下游服务，同步调用清清楚楚。为了「架构先进」引入 Kafka，然后多了一套部署、监控、故障处理 —— 不值。

**2. 需要立刻知道结果的时候**

用户提交表单，期望看到「保存成功」。如果这个结果依赖 MQ 下游的处理，那 MQ 就成了阻塞点，还得加轮询、加回调，绕一圈回到同步。

**3. 数据量很小的时候**

每天几千条消息，用数据库表当队列就够了（`SELECT ... FOR UPDATE SKIP LOCKED`）。专门部署 Kafka 是杀鸡用牛刀。

**4. 事务要求很强的时候**

订单状态和库存扣减必须原子完成时，跨服务的分布式事务比 MQ 更麻烦。这时候往往需要业务补偿逻辑，而不是消息队列。

## 选型：Kafka 还是 RabbitMQ

| | Kafka | RabbitMQ |
| --- | --- | --- |
| 模型 | 持久化日志 | 队列 + 路由 |
| 顺序保证 | 分区内有序 | 队列内有序 |
| 堆积能力 | 极强（磁盘） | 有上限（内存/磁盘告警） |
| 延迟 | 毫秒级 | 亚毫秒 |
| 消费模式 | 广播 / 扇出 | 推 / 拉 |
| 运维复杂度 | 高（ZK/KRaft） | 低 |
| 典型场景 | 日志流、埋点、流处理 | 业务消息、任务分发 |

**判断标准很简单**：

- 业务消息、需要精细路由和低延迟 → **RabbitMQ**
- 海量数据流、需要回放和多个独立消费组 → **Kafka**
- 团队没人专门运维 → 选 RabbitMQ，或者云厂商托管的 Kafka

## 可靠投递：消息可能丢的三个环节

消息从生产者到消费者，中间有三个可能丢的地方。

### 环节一：生产者 → MQ

生产者发完消息就崩溃，或者网络抖动消息没到。

**做法：生产者确认（Publisher Confirm）**

```python
def publish(topic: str, msg: dict):
    future = channel.basic_publish(
        exchange=topic,
        routing_key='',
        body=json.dumps(msg).encode(),
        properties=pika.BasicProperties(
            delivery_mode=2,          # 持久化
            message_id=str(uuid.uuid4()),
        ),
    )

    # 等待 broker 确认，不确认不算成功
    if not future.is_ready():
        raise PublishError('消息未被确认')

    # broker 持久化失败也要知道
    if not future.get(timeout=5):
        raise PublishError('消息写入失败')
```

`delivery_mode=2` 保证消息落盘而不只是进内存。**但这只解决了 broker 侧** —— 如果是多节点集群，还要确认副本数大于 0。

### 环节二：MQ 内部

broker 自己挂了。靠**持久化 + 多副本**解决：

```yaml
# RabbitMQ 队列定义
{
  "durable": true,          # 队列持久化
  "auto_delete": false,
  "arguments": {
    "x-queue-type": "quorum" # 仲裁队列，Raft 复制
  }
}
```

### 环节三：MQ → 消费者

消费者拿到消息，处理到一半崩溃，消息却已经从队列移除了。这是**最危险的一种丢消息**，因为它同时丢了数据和「重试机会」。

**解法：手动 ACK**

```python
def on_message(ch, method, properties, body):
    msg = json.loads(body)

    try:
        handle(msg)
        ch.basic_ack(delivery_tag=method.delivery_tag)     # 处理成功才确认
    except RetryableError:
        # 不 ACK，消息会重新投递
        raise
    except Exception:
        # 不可重试的错误，进死信队列
        ch.basic_reject(delivery_tag=method.delivery_tag, requeue=False)
```

**关键**：ACK 必须在业务处理**完成之后**。如果先 ACK 再处理，崩溃时消息就永久丢失了。

## 消费幂等：MQ 给你的是「至少一次」

即使配好了 ACK，消息仍然可能重复投递 —— 消费者处理完但 ACK 丢了，broker 重投。

**所以消费端必须幂等。** 这是使用 MQ 的硬性要求，不是可选项。

```python
def handle(msg: dict):
    event_id = msg['eventId']

    # 方案一：唯一索引去重（最可靠）
    try:
        db.insert(
            'processed_events',
            {'event_id': event_id, 'processed_at': now()},
        )
    except DuplicateKeyError:
        log.info(f'事件 {event_id} 已处理，跳过')
        return

    do_business_logic(msg)
```

```python
# 方案二：条件更新，只处理特定状态的数据
def handle_payment_success(msg):
    rows = db.update(
        'orders',
        {'status': 'paid', 'paid_at': msg['timestamp']},
        where="id = :id AND status = 'pending'",
    )

    if rows == 0:
        # 要么订单不存在，要么已经处理过
        return
```

**方案二更优**，因为它把幂等和业务逻辑合成了一步，不需要额外的表。

**不要用 Redis 去重做关键操作**。Redis 可能因故障丢数据，丢一次就导致重复扣款。关键路径的幂等必须落在数据库上。

### 表结构应该为幂等设计

```sql
-- 天然幂等：唯一约束兜底
CREATE TABLE webhook_events (
    id            BIGSERIAL PRIMARY KEY,
    provider      VARCHAR(50) NOT NULL,
    external_id   VARCHAR(128) NOT NULL,
    payload       JSONB NOT NULL,
    processed_at  TIMESTAMPTZ,
    UNIQUE (provider, external_id)     -- 关键约束
);
```

## 顺序性：全局有序是个陷阱

「消息必须按顺序处理」这个需求，实现成本比想象中高得多。

**分区/队列内的顺序可以保证，全局的不行。** 因为消费有并发：消费者 1 处理第 3 条时，消费者 2 可能正在处理第 4 条。

### 方案一：单队列单消费者

最简单，但吞吐也最低 —— 一个消费者串行处理，QPS 上限就那么高。

### 方案二：按 key 哈希到固定分区

```python
QUEUE_COUNT = 8

def get_partition(msg: dict) -> int:
    # 同一个订单的消息永远进同一个分区
    key = msg['order_id'].encode()
    return int.from_bytes(hashlib.md5(key).digest()[:4], 'big') % QUEUE_COUNT
```

同一个订单的消息进同一个分区，分区内串行消费 —— **订单级别的顺序有保证，不同订单之间并发**。

这通常是够用的：「同一订单的状态变更要有序」合理，「全站所有消息严格有序」不合理。

### 方案三：版本号

每条消息带一个递增的版本号，消费时检查：

```python
def handle(msg):
    current = redis.get(f'version:{msg["order_id"]}')

    if current and msg['version'] <= int(current):
        return          # 旧消息，丢弃

    do_business_logic(msg)
    redis.set(f'version:{msg["order_id"]}', msg['version'])
```

这个方案不依赖队列的顺序保证，但引入了状态管理成本。

## 事务消息：数据库和 MQ 的一致性

最难的问题是：**数据库写成功但消息发失败，或反过来。**

```python
# ❌ 两个独立的操作，没有原子性
db.insert(order)
mq.publish('order.created', order)
```

如果 `db.insert` 成功、`mq.publish` 失败，订单建了但下游永远不知道。

### 方案一：本地消息表

在同一个数据库事务里写业务数据和消息记录，由独立的进程扫描并投递。

```sql
CREATE TABLE local_messages (
    id           BIGSERIAL PRIMARY KEY,
    topic        VARCHAR(100) NOT NULL,
    payload      JSONB NOT NULL,
    status       SMALLINT DEFAULT 0,      -- 0待发送 1已发送 2失败
    retry_count  SMALLINT DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pending ON local_messages (status, next_retry_at)
    WHERE status = 0;
```

```python
def create_order(data):
    with db.begin():
        order = db.insert(Order, **data)
        # 同一事务写入待发消息
        db.insert('local_messages', {
            'topic': 'order.created',
            'payload': order.to_dict(),
        })
    return order


def scan_and_publish():          # 独立进程，秒级轮询
    msgs = db.query(
        "SELECT * FROM local_messages "
        "WHERE status = 0 AND next_retry_at <= now() "
        "ORDER BY id LIMIT 100"
    )

    for msg in msgs:
        try:
            mq.publish(msg['topic'], msg['payload'])
            db.update('local_messages', msg['id'],
                      {'status': 1, 'sent_at': now()})
        except Exception:
            # 指数退避重试
            delay = min(2 ** msg['retry_count'], 3600)
            db.update('local_messages', msg['id'], {
                'retry_count': msg['retry_count'] + 1,
                'next_retry_at': now() + timedelta(seconds=delay),
            })
```

**优点**：不依赖 MQ 的特性，任意 MQ 都能用，逻辑完全可控。
**缺点**：消息投递有延迟（取决于轮询间隔），多一个表要维护。

### 方案二：RocketMQ 事务消息

利用 MQ 自身提供的两阶段提交：

```python
tx_producer = transactional_producer.lookup('order-topic')

@register_listener(topic='order.created')
def check(order_id: str) -> TransactionStatus:
    order = query_order(order_id)

    if order:
        return TransactionStatus.COMMIT_MESSAGE   # 订单存在，提交消息
    return TransactionStatus.ROLLBACK_MESSAGE       # 不存在，回滚


def create_order(data):
    result = tx_producer.send_message_in_transaction(
        build_message(topic='order.created', data=data),
        business_arg=generate_order_id(),
        check_listener=check,
    )
    return result
```

流程：先发半消息（消费者看不到）→ 执行本地事务 → 提交或回滚。如果中间崩溃，MQ 定期回查 `check_listener` 来决定最终状态。

**优点**：无额外存储，对业务代码侵入小。
**缺点**：只能用 RocketMQ，且回查逻辑要保证幂等。

### 怎么选

- 团队已经有本地消息表的基础设施 → **方案一**
- 想少写代码且接受绑定 RocketMQ → **方案二**
- **对一致性要求不高**（比如统计、日志）→ 直接发消息 + 重试就行，不用上这一套

## 死信队列：给失败的消息一个归宿

处理失败的消息不能无限重试，也不能直接丢掉。

```python
RETRY_QUEUE = 'order.created.retry'
DLQ_QUEUE = 'order.created.dlq'
MAX_RETRIES = 5

def on_message(ch, method, properties, body):
    headers = properties.headers or {}
    retry_count = headers.get('x-retry-count', 0)

    try:
        handle(json.loads(body))
        ch.basic_ack(delivery_tag=method.delivery_tag)
    except NonRetryableError:
        # 业务上不可能成功，直接进死信
        ch.basic_reject(delivery_tag=method.delivery_tag, requeue=False)
    except Exception as e:
        if retry_count >= MAX_RETRIES:
            publish_to_dlq(body, reason=str(e))
            ch.basic_ack(delivery_tag=method.delivery_tag)
        else:
            # 延迟重试，不是立即重投
            publish_with_delay(RETRY_QUEUE, body, retry_count + 1)
            ch.basic_ack(delivery_tag=method.delivery_tag)
```

**区分「可重试」和「不可重试」很重要**。参数格式错误、记录不存在这类错误，重试一万次也是一样的结果；网络抖动、锁超时这类才值得重试。

死信队列需要配套的**告警和处理界面** —— 死信堆积是问题的信号，不能只放在那里不看。

## 一份设计检查清单

- [ ] 每个队列都有明确的名字和职责？
- [ ] 生产者开了 confirm？消息设了持久化？
- [ ] 消费者是**处理完成后**才 ACK？
- [ ] 消费逻辑幂等？幂等落在数据库还是缓存？
- [ ] 有死信队列？死信有告警和处理流程？
- [ ] 有没有区分可重试和不可重试错误？
- [ ] 顺序性需求是「全局有序」还是「按 key 有序」？后者才可实现
- [ ] 数据库和 MQ 的一致性方案是什么？接受多大的延迟窗口？
- [ ] 队列积压时怎么限流生产？还是让生产者一起崩？
- [ ] 消费延迟有没有监控？

最后一条尤其重要。**队列延迟是所有后端指标里最容易被忽略、也最能提前预警的** —— 它涨上去通常意味着流量涨了、消费者变慢了、或者数据库出问题了。等到下游开始超时才发现，往往已经积压到几千条了。