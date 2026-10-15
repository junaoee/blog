---
title: 后端可观测性：日志、指标与链路追踪
description: 出问题时怎么快速定位。这篇讲三大支柱各自的用途、结构化日志怎么写、Prometheus 指标该怎么埋、分布式追踪如何串起一次跨服务请求，以及告警怎么设才不会被淹没。
pubDate: 2026-10-09
tags: ['后端', '可观测性']
---

系统出问题时，最耗时间的从来不是修复，而是**搞清楚发生了什么**。

可观测性的目标不是「收集尽可能多的数据」，而是：**在故障发生时，能用最少的时间定位到问题所在。**

## 三大支柱

| 支柱 | 回答什么问题 | 数据形态 |
| --- | --- | --- |
| **日志 Logs** | 具体发生了什么？ | 离散的事件记录 |
| **指标 Metrics** | 系统整体健康吗？趋势如何？ | 随时间聚合的数值 |
| **追踪 Traces** | 一次请求经过了哪些服务？ | 请求的完整调用链 |

它们的定位不同，缺一不可：

- 只有日志 → 知道出了错，但不知道「错误率是不是在涨」
- 只有指标 → 发现 QPS 掉了，但不知道具体哪笔请求、哪里出错
- 只有追踪 → 看到某个请求很慢，但不知道服务整体的健康状况

## 结构化日志：别再打字符串拼接

最常见的写法，也是最难排查的写法：

```python
# ❌ 无法检索，无法聚合
log.info(f"用户 {user_id} 下单成功，订单 {order_id}，金额 {amount}，耗时 {elapsed}ms")
```

要查「昨天所有金额超过 1000 的订单」，你得写正则去 grep 几百万行文本。

**结构化日志把数据变成键值对**：

```python
import structlog

logger = structlog.get_logger()

logger.info(
    "order_created",
    user_id=user_id,
    order_id=order_id,
    amount=float(amount),        # 金额用数字，不是字符串
    elapsed_ms=elapsed,
    status="success",
)
```

输出是 JSON，可以被 Elasticsearch / Loki 直接索引：

```json
{
  "event": "order_created",
  "user_id": 12345,
  "order_id": "ord_01HQ8X",
  "amount": 199.00,
  "elapsed_ms": 42,
  "status": "success",
  "timestamp": "2026-10-09T08:30:15.123Z",
  "level": "info",
  "service": "order-api",
  "version": "1.4.2",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

现在同一个查询变成一行：

```json
order_created AND amount > 1000 AND status:"success"
```

### 关键字段的设计

**1. 事件名用统一的命名规范**

`order_created`、`order_failed`、`payment_timeout` —— 过去式，动宾结构。

不要写「处理订单」这种没法聚合的名字。同一个事件名在代码里只出现一次，字段可变化。

**2. 上下文自动注入**

手写 `user_id=current_user.id` 到处都会忘。用中间件统一注入：

```python
import structlog
import contextvars

# 用 contextvars 让日志自动带上当前请求的上下文
request_ctx = contextvars.ContextVar('request_ctx')

def logging_middleware(request, call_next):
    request_id = request.headers.get('X-Request-Id') or str(uuid.uuid4())
    user_id = getattr(request.state, 'user_id', None)
    trace_id = getattr(request.state, 'trace_id', None)

    # 绑定上下文，这个值在这个协程的所有日志里都可见
    request_ctx.set({
        'request_id': request_id,
        'user_id': user_id,
        'trace_id': trace_id,
    })

    response = call_next(request)
    response.headers['X-Request-Id'] = request_id
    return response


structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,    # 合并上下文
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt='iso'),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
)
```

之后业务代码只管记自己关心的：

```python
logger.info("order_created", order_id=order.id, amount=amount)
# 自动带上 request_id / user_id / trace_id
```

**3. 错误要记栈，但别记敏感信息**

```python
try:
    process_payment(order)
except PaymentError as e:
    logger.error(
        "payment_failed",
        order_id=order.id,
        provider=e.provider,
        error_code=e.code,
        exc_info=True,        # 记完整栈
    )
    raise
finally:
    logger.debug(
        "payment_request",
        card_number=mask(e.card),      # 脱敏
        cvv=undefined,                 # 绝不能出现
    )
```

**4. 日志级别要用对**

| 级别 | 什么时候用 | 生产环境 |
| --- | --- | --- |
| ERROR | 需要人介入处理 | 开启，触发告警 |
| WARN | 异常但已处理 | 开启 |
| INFO | 关键业务事件 | 开启，但要控制量 |
| DEBUG | 调试细节 | 关闭，用时动态开 |

**最常见的错误是 INFO 打太多**。每个循环、每次查询都打 INFO，日志量爆炸后存储成本飙升，还淹没了真正重要的信息。原则：**INFO 只记关键的业务状态变更。**

## 指标：选对类型比选对名字重要

Prometheus 的四种指标类型各有适用场景。

### Counter（计数器）—— 只增不减

适合：请求总数、错误总数、任务处理数。

```python
from prometheus_client import Counter

REQUESTS = Counter(
    'http_requests_total',
    'HTTP 请求总数',
    ['method', 'path', 'status'],      # label
)

REQUESTS.labels(method='GET', path='/orders', status='200').inc()
```

**不要用 Counter 记「当前有多少」** —— 它只增不减，进程重启会归零，画图出来全是对的但实际含义不对。

### Gauge（仪表）—— 可增可减

适合：连接池使用量、队列长度、内存占用。

```python
from prometheus_client import Gauge

QUEUE_LENGTH = Gauge('mq_queue_length', '消息队列积压量', ['queue_name'])

QUEUE_LENGTH.labels(queue_name='order.created').set(len(queue))
```

**队列积压是最值得监控的指标之一**，它通常在故障发生前很久就开始上涨。

### Histogram（直方图）—— 观测分布

适合：延迟、响应体大小。

```python
REQUEST_DURATION = Histogram(
    'http_request_duration_seconds',
    '请求耗时',
    ['method', 'path'],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

REQUEST_DURATION.labels(method='GET', path='/orders').observe(elapsed)
```

**Histogram 是延迟监控的核心。** 它不只给你平均值，而是让你能回答「99 分位的延迟是多少」。

> [!IMPORTANT]
> **永远不要用平均值看延迟。** 平均 100ms 听起来不错，但如果 1% 的请求是 10 秒，用户体验就是灾难。SLO 应该基于 P95/P99。

### Label 是双刃剑

Label 让指标有了维度，但**基数爆炸**是常见事故来源。

```python
# ❌ 灾难：每个用户一个时间序列
REQUESTS.labels(user_id=str(user.id)).inc()      # 百万用户 = 百万序列

# ❌ path 没归一化，每个 ID 一个序列
REQUESTS.labels(path=f'/orders/{order_id}').inc()

# ✅ 用路由模板
REQUESTS.labels(path='/orders/{id}').inc()
```

规则：**label 的值必须来自有限集合**。判断标准是「这个值有上界吗」—— 用户 ID 没有上界，路由模板有。

监控本身的资源消耗也可能拖垮服务，这是真实发生过的故障。

## 链路追踪：串起一次请求

一次用户请求可能经过网关、订单服务、库存服务、支付服务、数据库。没有追踪的话，你看到的是四个服务各自正常的日志，无法知道谁慢。

### OpenTelemetry

```python
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="http://collector:4317")))
trace.set_tracer_provider(provider)

FastAPIInstrumentor.instrument_app(app)
tracer = trace.get_tracer(__name__)


def get_order(order_id: str):
    with tracer.start_as_current_span("load_order") as span:
        span.set_attribute("order.id", order_id)
        span.set_attribute("db.system", "postgresql")

        result = db.query_one(
            "SELECT * FROM orders WHERE id = :id",
            {'id': order_id},
        )

        span.set_attribute("db.rows_found", 1 if result else 0)
        return result
```

自动插桩（`FastAPIInstrumentor`）会记录 HTTP 层和数据库调用的耗时，你只需要给关键的**业务逻辑**手动加 span。

### 上下文如何在服务间传递

W3C Trace Context 标准，通过 HTTP 头传递：

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              └─ trace-id ──────────────────────────────┘ └span-id┘ └flags┘
```

**跨服务调用必须透传这个头**，否则追踪链会断。网关或服务调用下游时，要么用支持 OTel 的客户端库自动传递，要么手动带：

```python
import httpx

def call_downstream():
    headers = {}
    trace.get_current_span().get_span_context()
    # 注入器会自动把 traceparent 加到 headers
    inject(headers)

    httpx.get("http://inventory-service/stock", headers=headers)
```

### 采样策略

全量追踪成本很高（存储 + 网络）。采样是必需的。

**头部采样**（在入口决定要不要记录）：按比例或按规则。

```python
class CustomSampler(Sampler):
    def should_sample(self, parent_context, trace_id, name, kind, attributes, links):
        # 错误请求全采，成功请求采 5%
        if attributes.get('http.status_code', 200) >= 500:
            return SamplingResult(Decision.RECORD_AND_SAMPLE)
        return SamplingResult(Decision.RECORD_AND_SAMPLE
                              if random.random() < 0.05
                              else Decision.DROP)
```

**尾部采样**（等请求结束后再决定）：先在内存里缓存整个 trace，如果里面有错误或延迟超阈值就上报，否则丢弃。**它能保证「所有出错的请求都有完整追踪」，同时只存少量成功请求的追踪**，成本更低。

> [!NOTE]
> 采样率别低于 1%。低于这个数，你在排查问题时经常会发现「这个请求恰好没被采到」。

### 关键 span 要打什么

不是所有操作都值得记录。优先级：

1. **跨服务调用** —— 一定要有
2. **数据库查询** —— 记录 SQL 模板（不是参数！参数可能含敏感信息）
3. **缓存操作** —— 命中率、耗时
4. **消息队列的生产和消费** —— 把两个 trace 关联起来
5. **重要的业务操作** —— 手动加

## 告警：少而准才有价值

**告警疲劳是监控系统失败的最常见方式**：告警太多 → 没人看 → 真出事了也不信告警。

### 告警基于症状，不基于原因

```python
# ❌ 原因告警：CPU 高不一定有问题
alert: pod_cpu_usage > 80%

# ✅ 症状告警：用户真的受影响了吗
alert: api_error_rate > 1% for 5m
alert: api_p99_latency > 1s for 5m
```

原因告警会在正常的高峰期疯狂触发，最后没人理。**症状告警直接对应用户体感**，才值得叫醒人。

### 分级

| 级别 | 定义 | 响应 |
| --- | --- | --- |
| P1 | 核心功能完全不可用 | 立刻叫人 |
| P2 | 核心功能降级 | 工作时间内处理 |
| P3 | 非核心异常 | 记录，工作时间处理 |

**半夜叫人起床的告警应该少到让团队愿意响应。** 如果每周有五件事半夜找你，你会开始忽略所有 P1。

### 具体怎么设

```yaml
groups:
  - name: api
    rules:
      # 错误率：5 分钟内超过 1%
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
          / sum(rate(http_requests_total[5m])) > 0.01
        for: 5m
        labels:
          severity: page       # 半夜叫人
        annotations:
          summary: "错误率 {{ $value | humanizePercentage }}"

      # 队列积压：10 分钟内持续增长
      - alert: QueueBacklogGrowing
        expr: |
          deriv(mq_queue_length[10m]) > 0
          and mq_queue_length > 1000
        for: 10m
        labels:
          severity: ticket     # 工作时间处理

      # 延迟：用 P99 而不是平均
      - alert: HighLatency
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
          ) > 1
        for: 5m
        labels:
          severity: ticket
```

注意三个细节：

- **`for: 5m` 的持续时间** —— 避免瞬时抖动触发告警
- **`deriv()` 判断趋势** —— 队列积压 1000 条可能是正常的，但**持续增长**意味着上游有变化、下游跟不上，这才是问题
- **`severity` 标签** —— 路由到不同通道

## 黄金四指标（Google SRE）

每个服务至少监控这四个：

| 指标 | 定义 | 关注点 |
| --- | --- | --- |
| **延迟 Latency** | 请求耗时分布 | P50 体验、P99 尾部 |
| **流量 Traffic** | 请求速率 | 突增突降 |
| **错误 Errors** | 失败请求比例 | 5xx 比例 |
| **饱和度 Saturation** | 资源接近上限的程度 | 队列长度、连接池、CPU |

**饱和度是最容易被漏掉的。** 队列长度、连接池使用率、内存水位 —— 这些资源在真正耗尽之前，通常已经积压了一段时间。这段积压时间就是你发现问题的窗口。

## 排查流程

出问题时按这个顺序走，能省掉大量盲目搜索。

```text
1. 现象是什么？
   └─ 指标：哪个指标异常？什么时间开始的？

2. 影响范围多大？
   └─ 指标：全部用户还是部分？哪个接口？

3. 什么时候开始的？
   └─ 指标：对比历史，看有无关联变更

4. 变了什么？
   └─ 追踪：找一个 traceId 作为入口

5. 哪个环节慢/错？
   └─ 追踪：看各 span 的耗时，定位到具体服务

6. 具体报错是什么？
   └─ 日志：用 traceId 检索该次请求的完整日志
```

**关键是第 4 步 —— 用指标定位时间点，再用追踪找到具体请求，最后用日志看细节。**

直接从日志开始搜是常见错误：几百万行日志里找到一个相关的 stack trace 极其困难，而且你事先不知道该搜什么关键词。

## 一份最小可行清单

不要一开始就上全套工具。**先把这几样做好，价值比堆工具大得多**：

- [ ] 日志是结构化的（JSON），关键事件有统一命名
- [ ] 每个请求都有 request_id，贯穿所有日志
- [ ] 四个黄金指标都有监控面板
- [ ] 延迟用 Histogram，能看 P99
- [ ] 告警基于用户可感知的症状，且有分级
- [ ] 队列积压、消费延迟这类「先兆指标」有监控
- [ ] 跨服务调用传递了 trace 上下文
- [ ] 有能力按 traceId 检索出完整调用链

**先做到能快速定位问题，再考虑上更 fancy 的工具。** 大多数团队的监控问题不是工具不够，而是没把基础这几样做扎实。