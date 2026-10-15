---
title: API 设计的原则与实践
description: RESTful 不是把动词拼进 URL 就完事了。这篇讲资源建模、HTTP 方法语义、错误格式、分页、幂等性，以及版本管理里那些真正会踩的坑。
pubDate: 2026-10-14
tags: ['后端', 'API']
---

写 API 的人大概都经历过这个阶段：明明按 RESTful 的规范写了，评审时还是被挑出一堆问题。问题往往不在「有没有用 RESTful」，而在**资源建模的方式**和**边界情况的处理**上。

这篇按重要性从高到低讲，前面几条是地基，后面几条是打磨。

## 资源建模：先想清楚「东西」，再想「动作」

最常见的错误是把动词塞进 URL：

```
❌  POST /createUser
❌  GET  /getUserList?page=1
❌  POST /deleteUser?id=123
```

这说明设计者还在用「过程」而不是「资源」思考。正确的做法是先回答一个问题：**系统里有哪些东西？**

用户、订单、商品、评论 —— 这些是名词，是资源。然后用 HTTP 方法表达对资源的操作：

```
POST   /users            创建
GET    /users            列表
GET    /users/123        读取单个
PATCH  /users/123        部分更新
DELETE /users/123        删除
```

那「登录」这种动作怎么办？它不是 CRUD 里的操作，**动作可以作为资源存在**：

```
POST /sessions        登录，创建一个会话
DELETE /sessions/current   注销，销毁当前会话
```

用户点「取消订单」也不该是 `PUT /orders/123/cancel`，而应该是把订单状态作为一个子资源来表达：

```
POST /orders/123/cancellation    创建一个取消动作
GET  /orders/123/cancellation    查询是否已取消
DELETE /orders/123/cancellation  撤销取消
```

这样每个动作都有自己的 URI 和生命周期，比在一个大对象上堆 `status` 字段清晰得多。

> [!TIP]
> 一个判断标准：如果同一个名词能搭配 GET/POST/PATCH/DELETE 四种方法，那它大概率是个真正的资源。如果只能用 POST + 某个动作名，那它可能更适合建模成动作资源。

## HTTP 方法语义不是随便选的

HTTP 规范对方法的语义有明确定义，选错方法会直接影响缓存、幂等性和重试的安全性。

| 方法 | 幂等 | 有请求体 | 成功状态码 | 语义 |
| --- | --- | --- | --- | --- |
| GET | 是 | 否 | 200 | 查询，不应有副作用 |
| HEAD | 是 | 否 | 200 | 只取响应头，常用于探测资源是否存在 |
| POST | 否 | 是 | 201 / 200 | 创建或执行非幂等动作 |
| PUT | 是 | 是 | 200 / 204 | 整体替换，要求完整 |
| PATCH | 否 | 是 | 200 / 204 | 部分更新 |
| DELETE | 是 | 可有 | 204 | 删除，重复调用结果相同 |

**幂等**是这个表里最重要的概念。幂等的意思是：同一个请求执行一次和执行多次，对服务端状态的影响相同。

为什么重要？因为网络会超时。客户端不知道请求有没有到达服务端，只能重试。

- `GET /users/123` 重试十次，只是读了十次，没有副作用
- `POST /payments` 重试两次，可能扣了两次款 —— 这是事故

所以**任何会产生副作用的 POST，都要想办法让它变得可重试安全**，方法在后面讲。

还有一个容易踩的坑：**GET 绝不能有副作用**。很多人图省事，把「删除文章」写成 `GET /posts/123/delete`，理由是「方便用浏览器访问」。后果是浏览器预加载、爬虫抓取、链接预览都会触发删除。

## 错误响应：给调用方能用的信息

后端返回错误时，最糟的做法是这样：

```json
{
  "success": false,
  "message": "操作失败"
}
```

调用方拿这个信息什么都做不了。你至少要告诉他**哪出了问题**、**怎么改**。

一个通用的错误结构：

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "账户余额不足，当前余额 12.50，本次需要 50.00",
    "details": [
      {
        "field": "amount",
        "reason": "must be less than or equal to available balance"
      }
    ],
    "requestId": "01HQ8XK2M9N3P7Q5"
  }
}
```

几个设计要点：

**1. `code` 给机器读，`message` 给人读**

前端要判断「余额不足」来弹窗，用的是 `code`；直接显示给用户看的是 `message`。两者不能混用 —— 让前端去匹配中文文案，是把埋雷留给下一个人。

**2. HTTP 状态码要真的用起来**

| 状态码 | 场景 |
| --- | --- |
| 400 | 请求格式错误、参数校验失败 |
| 401 | 没登录或凭证失效 |
| 403 | 登录了但没权限 |
| 404 | 资源不存在 |
| 409 | 状态冲突，比如重复下单、版本号不匹配 |
| 422 | 语法对但语义不对，比如邮箱格式 |
| 429 | 触发限流 |
| 500 | 服务端未预期的错误 |

**403 和 404 的区别**经常被搞混。要看产品需求：如果一个用户不该看到某条私有资源存在，返回 403（我承认它存在但你不能看）；如果连存在都不该暴露，返回 404（装作没有这回事）。

**3. 带上 requestId**

线上排查问题的时候，最花时间的往往不是定位故障，而是找到「用户那次请求对应的日志」。每个请求生成唯一 ID，响应里带上，日志里也带上，出问题时让用户提供这个 ID，就能精确捞出整条链路。

## 分页：别用 offset

offset 分页的写法是 `LIMIT 20 OFFSET 100`，意思是「跳过前 100 条，取 20 条」。它有个致命问题：**数据变了，分页就会错乱或漏数据**。

用户翻到第 3 页时，有人插入了两条新记录，那么第 3 页的第 1 条会和第 2 页重复，有一条被跳过。删除数据时同理。

游标分页（keyset pagination）解决了这个问题：**用上一页最后一条记录的排序值作为起点**。

```sql
-- 第一次请求
SELECT id, title, created_at
FROM posts
WHERE status = 'published'
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- 下一页，把上一页最后的 created_at 和 id 传回来
SELECT id, title, created_at
FROM posts
WHERE status = 'published'
  AND (created_at, id) < ('2026-10-01T10:00:00Z', 8451)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

`WHERE (created_at, id) < (...)` 这种写法叫**行值比较**，PostgreSQL 和 MySQL 都支持。它能正常工作有个前提：`(created_at, id)` 上必须有索引。

> [!NOTE]
> 加上 `id` 作为第二排序键是为了处理 `created_at` 重复的情况。如果只用时间戳排序，而两篇文章时间戳一模一样，其中一篇就会永远翻不到。

offset 分页什么时候还能用？**数据不会变、且需要跳页**的场景，比如后台管理系统里的表格 —— 用户要能直接跳到第 50 页。这两种分页不冲突，按场景选。

## 幂等性：让 POST 可以安全重试

回到前面那个问题：网络超时时，客户端怎么知道要不要重试？

答案是**幂等键（idempotency key）**。客户端为每个「意图」生成一个唯一 ID，重试时用同一个 ID，服务端记录这个 ID 是否已经处理过。

```python
import uuid
from redis import Redis

redis = Redis()


def handle_payment(idem_key: str, payload: dict) -> dict:
    # 标记处理中，并设置过期时间
    lock = redis.set(f"idem:{idem_key}", "processing", nx=True, ex=300)

    if lock is None:
        # 已经在处理了，返回之前的结果
        cached = redis.get(f"idem_result:{idem_key}")
        if cached:
            return json.loads(cached)
        raise ConflictError("请求正在处理中，请稍后重试")

    try:
        result = do_payment(payload)

        # 保存结果，后续重复请求直接返回
        redis.setex(f"idem_result:{idem_key}", 86400, json.dumps(result))
        return result
    except Exception:
        # 失败则删除标记，允许客户端重试
        redis.delete(f"idem:{idem_key}")
        raise
```

三个关键点：

1. **幂等键由客户端生成**，服务端只是记录它。服务端生成的话，重试时会生成新的键，起不到作用。
2. **必须保存处理结果**，不只是记录「处理过」。否则重试时你不知道上一次的结果是什么，只能报错说「请查询」—— 体验很差。
3. **过期时间要合理**。通常比客户端的重试窗口长一点，24 小时是常见选择。

这套模式对**支付、下单、发短信、扣库存**这类操作特别重要。

## 版本管理：别急着上

看到 `/api/v1/` 就想讨论怎么演进，但多数项目活不到需要第二个版本。

真正务实的分级：

**路径版本**（`/api/v1/users`）—— 简单粗暴，但一旦发出去就很难删，最终会有 `/v1` `/v2` `/v3` 并存的局面。

**请求头版本**（`Accept: application/vnd.app.v2+json`）—— 干净，但调试麻烦，很多人不会。

**字段级兼容** —— 多数问题的正确答案。**加字段是向后兼容的，改字段类型和删字段不是。**

```json
// v1 返回
{
  "name": "张三",
  "age": 30
}

// 改成 v2 —— 破坏兼容
{
  "fullName": "张三",
  "age": "30"    // number 变 string，老客户端会崩
}

// 更好的做法
{
  "name": "张三",
  "fullName": "张三",   // 新增，老客户端忽略
  "age": 30,
  "ageStr": "30"        // 需要字符串格式时另开字段
}
```

还有几个常被忽略的破坏性变更：

- 把可选参数改成必填
- 把数组改成对象（`[1,2,3]` → `{"a":1}`）
- 把字段名改掉（哪怕只是改了大小写）
- 收紧校验规则（原来允许的输入现在报 400）
- 改变枚举值的含义（比如 `status: 1` 原来表示「已完成」，改成了「已取消」）

## 字段命名的细节

这部分没什么技术含量，但踩坑的人最多。

**时间统一用 UTC 存储**，展示时转本地时区。

```json
{
  "createdAt": "2026-10-14T08:30:00Z",     // ✅ ISO 8601，带 Z
  "createdAt": 1759823400,                 // ✅ Unix 时间戳，机器友好
  "createdAt": "2026/10/14 16:30:00",      // ❌ 时区不明，解析器各异
  "createdAt": "Wed Oct 14 2026"           // ❌ 不要用这种
}
```

**布尔值用 `is` / `has` 前缀**，或者干脆用正反义明确的词：`isActive` 比 `active` 好，因为 `active` 到底表示「启用」还是「活跃」有歧义。

**金额用最小单位整数**，别用浮点数：

```json
{ "price": 19.99 }     // ❌ 浮点数有精度问题
{ "price": 1999, "currency": "CNY" }   // ✅ 分为单位
```

这不是洁癖。`0.1 + 0.2 !== 0.3` 在任何语言都成立，而对账时差一分钱就是事故。存 `19.99` 到数据库、用浮点数计算、再取整 —— 每一环都在引入误差。

## 请求校验：信任边界

任何来自客户端的数据都要当成不可信输入。原则是**在系统边界校验一次，之后内部代码信任它**。

```python
from pydantic import BaseModel, Field, field_validator


class CreateUserRequest(BaseModel):
    email: str = Field(max_length=255)
    age: int = Field(ge=0, le=150)
    nickname: str = Field(min_length=1, max_length=30)

    @field_validator('email')
    @classmethod
    def check_email(cls, v: str) -> str:
        if '@' not in v or '.' not in v.split('@')[-1]:
            raise ValueError('邮箱格式不正确')
        return v.lower().strip()

    @field_validator('nickname')
    @classmethod
    def no_control_chars(cls, v: str) -> str:
        if any(ord(c) < 32 for c in v):
            raise ValueError('昵称不能包含控制字符')
        return v
```

注意 `no_control_chars` 这个校验器 —— 它防的是控制字符，而不只是空格。如果不拦，`\n`、`\x00`、零宽字符就能进数据库，在某些前端和日志系统里造成显示错乱甚至注入。

**SQL 注入**的防线是参数化查询，不是字符串拼接：

```python
# ❌ 拼接字符串
cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")

# ✅ 参数化
cursor.execute("SELECT * FROM users WHERE name = %s", [name])
```

同理，**富文本要在渲染前做 HTML 消毒**。允许 `<script>` 通过就等于让用户在你的域名下执行任意 JavaScript。

## 速率限制

没有限流的接口，迟早会被爬一遍或者被 DDoS 拖垮。

常见的几种算法：

**固定窗口**（最简单）—— 每分钟计数，60 秒清零。问题是窗口边界会被打两次流量。

**滑动窗口** —— 记录每个请求的时间戳，统计最近 N 秒内的数量。准确但存储成本高。

**令牌桶**（推荐）—— 桶里放令牌，以固定速率放，取令牌才能通过，桶可设置容量允许突发流量。

```python
class TokenBucket:
    def __init__(self, capacity: int, refill_rate: float):
        self.capacity = capacity
        self.refill_rate = refill_rate  # 每秒放几个令牌
        self.tokens = capacity
        self.last = time.monotonic()

    def allow(self) -> bool:
        now = time.monotonic()
        # 先按时间流逝补充令牌
        self.tokens = min(
            self.capacity,
            self.tokens + (now - self.last) * self.refill_rate
        )
        self.last = now

        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False
```

令牌桶的好处是**允许合理的突发**（比如页面加载瞬间发 10 个请求），同时限制长期平均速率 —— 这符合真实用户行为。

限流触发时返回 **429**，并带上 `Retry-After` 头告诉客户端多久后重试：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1759823430
```

## 长任务：用异步接口

上传视频、生成报表、导出数据这类操作，几十秒到几小时都可能。HTTP 请求挂在那里等是行不通的 —— 网关有超时，用户关页面就断了。

标准做法是**返回 202 Accepted，让客户端轮询或订阅回调**：

```
POST /exports
→ 202 Accepted
  {
    "jobId": "exp_01HQ8X...",
    "statusUrl": "/exports/exp_01HQ8X..."
  }

GET /exports/exp_01HQ8X...
→ 200 OK
  {
    "status": "processing",
    "progress": 0.42
  }
```

轮询要带退避间隔，不要固定间隔 —— 否则服务端压力反而更大：

```python
delay = 1.0
while True:
    resp = get_status(job_id)
    if resp['status'] in ('completed', 'failed'):
        break
    sleep(delay + random.uniform(0, delay))  # 抖动，避免同时打过来
    delay = min(delay * 1.5, 30)             # 指数退避，封顶 30 秒
```

## 一份检查清单

写完一个 API，问自己这些问题：

- [ ] URL 里有没有动词？动作能否建模成资源？
- [ ] 有副作用的操作，能安全重试吗？
- [ ] 错误响应里有稳定的 `code` 和 `requestId`？
- [ ] 分页在数据变动时会不会错乱？
- [ ] 新增字段向后兼容吗？有没有意外收紧校验？
- [ ] 时间格式带时区了吗？金额用整数了吗？
- [ ] 所有用户输入都校验了？SQL 都参数化了？
- [ ] 有速率限制吗？超限返回 429 了吗？
- [ ] 长任务会不会超过网关超时？
- [ ] 时间字段、金额、布尔值的命名是否无歧义？

这十条过一遍，API 的质量基本就稳了。