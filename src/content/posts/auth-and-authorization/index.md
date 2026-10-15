---
title: 认证与授权：Session、JWT 与 OAuth2
description: 登录状态存哪、JWT 怎么签发和撤销、OAuth2 四种授权流程分别用在哪、密码该怎么存。这篇把后端认证的核心问题和常见误区讲清楚。
pubDate: 2026-10-10
tags: ['后端', '安全']
---

认证（Authentication）解决「你是谁」，授权（Authorization）解决「你能做什么」。这两件事经常被混为一谈，代码里也经常互相渗透，导致一改就出漏洞。

## 先把概念分清

| | 认证 Authentication | 授权 Authorization |
| --- | --- | --- |
| 问题 | 你是谁？ | 你能做什么？ |
| 手段 | 密码、验证码、第三方登录 | 角色、权限、ACL、策略 |
| 失败表现 | 401 Unauthorized | 403 Forbidden |

常见错误是**用 403 表示认证失败**。认证失败应该返回 401 并带上 `WWW-Authenticate` 头，客户端才知道「该去登录了」；403 表示身份已确认，只是权限不够。

## 密码存储：不要自己做

**绝对不要**：MD5、SHA1、直接存明文、只加盐不做慢哈希。

```python
# ❌ 全是错的
hashlib.md5(password.encode()).hexdigest()
hashlib.sha1(password.encode()).hexdigest()

# ❌ 自己造的"加密"（彩虹表秒破）
encrypt(password, my_own_algorithm)
```

MD5 和 SHA1 是为速度设计的，攻击者可以用 GPU 每秒尝试几十亿次。而且无盐哈希可以直接查彩虹表 —— 加盐是必要的，但更根本的问题是**要用慢哈希**。

**应该用 bcrypt、scrypt 或 Argon2**：

```python
import bcrypt

def hash_password(password: str) -> bytes:
    # cost=12 大约需要 250ms，OWASP 推荐的量级
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode('utf-8'), salt)


def verify_password(password: str, hashed: bytes) -> bool:
    try:
        return bcrypt.checkpw(password.encode('utf-8'), hashed)
    except ValueError:
        return False
```

三个算法的取舍：

| 算法 | 特点 |
| --- | --- |
| **Argon2id** | 内存困难，抗 GPU/ASIC 并行破解，当前首选 |
| **bcrypt** | 成熟稳定，生态好，72 字节输入上限 |
| **scrypt** | 内存困难，参数调优需要经验 |

慢哈希的代价是**故意让登录变慢**。这正是目的：正常用户一次登录几百毫秒无感，攻击者每分钟只能试几十次。

> [!WARNING]
> bcrypt 的 72 字节上限容易被忽略。超长密码在某些实现里会被**静默截断**，用户设的 80 字符密码只有前 72 字节生效。如果需要支持超长密码，用 Argon2 或先做一次 SHA-256 预哈希（注意这会消除 null 字节注入风险）。

**永远不要把用户密码放进日志**，包括「登录失败」这类调试日志 —— 密码出现在日志里就等于泄露给了所有有日志权限的人。

## Session：简单可靠的传统方案

服务端存会话状态，客户端只拿一个会话 ID。

```python
def login(request):
    user = db.find_user_by_email(request.email)

    if not user or not verify_password(request.password, user.password_hash):
        # 统一提示，不告诉用户到底是邮箱不存在还是密码错
        raise AuthenticationError('邮箱或密码错误')

    session_id = secrets.token_urlsafe(32)    # 32 字节随机，足够安全
    session_data = {
        'user_id': user.id,
        'created_at': time.time(),
        'ip': request.remote_addr,
    }
    redis.setex(f'session:{session_id}', 86400, serialize(session_data))

    response.set_cookie(
        'session_id', session_id,
        httponly=True,      # JavaScript 读不到，防 XSS 窃取
        secure=True,        # 只走 HTTPS
        samesite='lax',     # 防跨站请求伪造
        path='/',
    )
    return {'ok': True}
```

### 三个 Cookie 属性不能少

**HttpOnly** —— 加上后 `document.cookie` 读不到这个值。防的是 XSS 攻击：即使页面上有注入的脚本，也偷不走会话。

**Secure** —— 只在 HTTPS 下传输。HTTP 下明文 Cookie 等于把登录凭证贴在墙上。

**SameSite** —— `Lax` 是现代浏览器的合理默认值，能防住大部分 CSRF。设为 `None` 时**必须**同时有 Secure。

### Session 存储的取舍

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 内存 | 最快 | 多实例不共享，重启丢失 |
| Redis | 快，可共享 | 需要额外组件 |
| 数据库 | 无额外组件 | 每个请求都查库 |

多实例部署基本都用 Redis。单机小项目可以先内存 + 定期持久化。

### Session 的真正缺点

**无法跨站共享。** 用户在 `a.com` 登录了，`b.com` 不知道。这催生了 OAuth；也让「移动端 App + 多个前端」变得麻烦。

另一个问题是**服务端存储开销**。百万用户在线就意味着百万条会话记录。

JWT 常被当作 Session 的替代品，但它解决的是**不同的问题**，而且引入了新的麻烦。

## JWT：不是 Session 的银弹

JWT（JSON Web Token）的卖点是「自包含」—— 把信息签进 token 本身，服务端不需要存储任何东西。

```python
import jwt
from datetime import datetime, timedelta, timezone

SECRET = os.environ['JWT_SECRET']
ALGORITHM = 'HS256'


def create_access_token(user_id: int, roles: list) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        'sub': str(user_id),
        'roles': roles,
        'iat': now,
        'exp': now + timedelta(minutes=15),      # 短有效期
        'jti': str(uuid.uuid4()),                 # 唯一 ID，用于撤销
        'iss': 'my-api',                          # 签发者
        'aud': 'my-app',                          # 接收方
    }
    return jwt.encode(payload, SECRET, algorithm=ALGORITHM)


def verify_token(token: str) -> dict:
    options = {
        'verify_signature': True,
        'verify_exp': True,
        'verify_iss': True,
        'verify_aud': True,
        'require': ['exp', 'iat', 'sub'],
    }
    return jwt.decode(
        token, SECRET, algorithms=[ALGORITHM],
        issuer='my-api', audience='my-app', options=options,
    )
```

**必须校验的项**：`签名`、`exp`（过期）、`iss`（签发者）、`aud`（接收者）、`alg`（算法）。

最后一项尤其重要 —— **必须固定算法，不要从 token 里读**：

```python
# ❌ 致命漏洞：攻击者可以把 alg 改成 "none"，或改成对称算法
jwt.decode(token, key, algorithms=jwt.algorithms.get_default_algorithms())

# ✅ 显式指定允许的算法
jwt.decode(token, SECRET, algorithms=['HS256'])
```

如果服务用 HS256（非对称算法的一半），攻击者拿到公钥就能伪造签名。**混用 HS256 和 RS256 曾经导致大量系统被攻破**，因为 RS256 的公钥可以被当作 HMAC 密钥使用。

### JWT 的三个硬伤

**1. 无法撤销**

Token 在有效期内一直有效。用户「登出」了，但那个 token 还能继续用 —— 因为服务端根本不记录它。

缓解办法是维护一个黑名单：

```python
def revoke(token: str):
    payload = jwt.decode(token, options={'verify_signature': False})
    # 黑名单 TTL 设为 token 的剩余寿命
    redis.setex(
        f"jwt:blacklist:{payload['jti']}",
        int(payload['exp'] - payload['iat']),
        '1',
    )


def verify_and_check_revoked(token: str) -> dict:
    payload = jwt.decode(token, SECRET, algorithms=['HS256'])

    if redis.exists(f"jwt:blacklist:{payload['jti']}"):
        raise AuthenticationError('token 已撤销')

    return payload
```

注意：**这实质上又回到了有状态**。所以如果你的系统需要频繁撤销（比如「改密码后踢掉所有设备」），Session 反而更简单。

**2. 无法更新**

用户改了权限，但旧 token 里的 `roles` 还是旧的。要等它自然过期。解决办法同上 —— 发新 token，或者加黑名单。

**3. Token 太大**

JWT 的 header 和 payload 都是 Base64 编码（**不是加密**，任何人都能解开看内容）。如果往里塞太多信息，token 可能膨胀到几 KB，每次请求都带着跑。

**不要在 JWT 里放敏感信息。** 它只是签名保证没被篡改，不是保密的。

### 实际建议

JWT 适合这些场景：

- **纯 API 服务**，无状态是硬需求（大量微服务、跨域调用）
- **第三方集成** —— 别人用你的 API，你不需要管理会话
- **短生命周期的访问令牌**（15 分钟以内）+ 刷新令牌

**如果你的场景是「同一个网站的多个页面」—— 用 Session。** 它更简单，能立即撤销，浏览器兼容性也没问题。

一个折中的实用方案：**Access Token（JWT，15 分钟）+ Refresh Token（Session 存储，可撤销）**。短期内的无状态，加上需要撤销时的控制力。

### 刷新令牌的设计

```python
def refresh(refresh_token: str):
    data = redis.get(f'refresh:{hash(refresh_token)}')

    if not data:
        raise AuthenticationError('refresh token 无效')

    session = deserialize(data)

    # 检测重放：如果同一个 token 用过两次，说明可能被窃取
    used = redis.getset(f'refresh_used:{hash(refresh_token)}', '1', ex=86400)
    if used:
        # 撤销整个 token 家族
        revoke_family(session['family_id'])
        raise AuthenticationError('检测到 token 重放，已撤销全部会话')

    user = db.get(User, session['user_id'])
    return create_access_token(user.id, user.roles)
```

**轮换（rotation）是必须的**：每次刷新都发新的 refresh token，旧的作废。否则 refresh token 长期有效，等于给了攻击者永久访问权。

「检测重放 → 撤销全家」这个设计能定位到 token 泄露：受害者正常刷新时如果收到「token 已使用」错误，说明有人拿着偷来的 token 在用。

## OAuth 2.0：第三方登录的标准

OAuth 解决的是**授权委托**：「我允许应用 B 访问我在应用 A 上的数据，不需要把密码给 B」。

### 四种授权流程

| 流程 | 用途 | 前提 |
| --- | --- | --- |
| **授权码** Authorization Code | 有后端的 Web 应用 | 最常用 |
| **隐式** Implicit | 纯前端 SPA | **已不推荐** |
| **密码** Resource Owner Password | 高度可信的第一方应用 | 基本不用 |
| **客户端凭证** Client Credentials | 服务间调用，无用户参与 | 机器对机器 |

**授权码流程的标准步骤**：

```text
1. 用户点击「用 Google 登录」
2. 前端把用户重定向到授权服务器的授权端点，带上 client_id、redirect_uri、state
3. 用户在授权服务器上登录并同意授权
4. 授权服务器重定向回 redirect_uri，附带 ?code=授权码&state=...
5. 前端把 code 发送到自己的后端
6. 后端用 code + client_secret 换取 access_token
7. 后端用 access_token 调用资源服务器获取用户信息
```

**为什么必须是后端换 token？** 因为 `client_secret` 绝不能出现在前端代码里。如果用隐式流程，token 直接在浏览器里传递，攻击者通过 XSS 就能拿到。

**PKCE 是授权码流程的现代增强**，即使没有 client_secret 也安全 —— 移动端和单页应用应该用「授权码 + PKCE」。

### state 参数不能省

`state` 是防 CSRF 的关键：客户端生成随机值放进请求，授权服务器原样返回，回来时比对。

```python
# 发起授权前
state = secrets.token_urlsafe(24)
session['oauth_state'] = state
redirect_to_authorize(client_id, redirect_uri, state, scope)

# 回调时
if request.args.get('state') != session.pop('oauth_state'):
    raise AuthenticationError('state 校验失败，可能是 CSRF 攻击')
```

没有这个校验，攻击者可以构造一个回调链接把自己的账号绑到受害者的账户上（账号接管）。

### refresh_token grant

自己实现第三方登录时的关键一步：access_token 过期后用 refresh_token 换新的。

```python
def refresh_tokens(session_id: str):
    session = get_session(session_id)
    token = session['refresh_token']

    resp = http.post(
        f"{PROVIDER}/oauth/token",
        data={
            'grant_type': 'refresh_token',
            'refresh_token': token,
            'client_id': CLIENT_ID,
            'client_secret': CLIENT_SECRET,
        },
        timeout=10,
    )

    new_token = resp.json()['access_token']

    if 'refresh_token' in resp.json():
        session['refresh_token'] = resp.json()['refresh_token']

    session['access_token'] = new_token
    session['expires_at'] = time.time() + resp.json()['expires_in']

    save_session(session_id, session)
    return new_token
```

**每个用户会话各自存一份 token**，不要全系统共用 —— 共用会导致「A 用户的请求用了 B 用户的 token」这种极难排查的问题。并发场景下多个请求同时刷新时要加锁，否则后一个请求会用已失效的 refresh token，覆盖掉前一个刷新的结果。

## 权限设计：别只靠角色

**RBAC**（基于角色）简单直观：

```python
ROLES = {
    'user':    ['post:read', 'comment:create'],
    'editor':  ['post:read', 'post:write', 'comment:create', 'comment:delete'],
    'admin':   ['*'],
}

def can(user, permission: str) -> bool:
    perms = ROLES.get(user.role, [])
    return '*' in perms or permission in perms
```

问题是**角色会爆炸**。「能编辑自己文章但不能编辑别人的编辑」这种权限，RBAC 要新建一堆角色（「初级编辑」「高级编辑」「区域编辑」），最后没人说得清每个角色到底能干什么。

**ABAC**（基于属性）更灵活：

```python
def can_edit_post(user, post) -> bool:
    if user.is_admin:
        return True
    if post.author_id != user.id:
        return False                    # 不是自己的文章
    return post.status in ('draft', 'published')   # 已归档的不能改
```

**最实用的往往是混合**：用角色做粗粒度控制（哪些人能进管理后台），用属性做细粒度判断（能不能改这一篇）。

### 检查放在哪一层

**不要只在接口里检查**。一个真实案例：接口检查了权限，但**数据库查询没有限制范围**：

```python
# ❌ 检查了是不是作者，但没检查是不是自己的文章
def update_post(post_id):
    post = db.get(Post, post_id)
    if not can_edit_post(current_user, post):     # 作者判断
        raise Forbidden()

    # 但是！post_id 是用户传的，他可以传别人的 post_id
    # 如果 post 查询没带 author_id 条件，作者判断就形同虚设
```

正确的做法是**把权限条件下推到查询里**：

```python
def update_post(post_id):
    post = db.query_one(
        "SELECT * FROM posts WHERE id = :id AND author_id = :author",
        {'id': post_id, 'author_id': current_user.id},
    )
    if not post:
        raise NotFound()          # 不区分「不存在」和「无权限」
```

这样权限和数据范围在同一条 SQL 里，不给中间环节留空隙。

## 常见攻击与防御

**SQL 注入** —— 参数化查询，别拼字符串。

**越权访问（IDOR）** —— 上面说的，把权限条件写进查询。

**CSRF** —— 传统 Web 用 SameSite Cookie + CSRF Token；纯 API（Bearer Token）天然免疫，因为浏览器不会自动附带 `Authorization` 头。

**XSS 窃取 Token** —— 存在 localStorage 的 token 会被 XSS 读到。所以：

- 有 HttpOnly Cookie 可用时优先用它
- 必须存 localStorage 时，严格做输出转义、CSP 策略

**令牌泄露在日志里** —— 请求日志别打完整的 `Authorization` 头和 Cookie。

```python
SENSITIVE = {'authorization', 'cookie', 'set-cookie', 'x-api-key'}

def scrub(log_record: dict) -> dict:
    return {
        k: ('***' if k.lower() in SENSITIVE else v)
        for k, v in log_record.items()
    }
```

## 一份检查清单

**密码与凭证**

- [ ] 密码用 bcrypt / Argon2 存储，不是 MD5/SHA1/自定义加密？
- [ ] 日志里没有明文密码？
- [ ] 数据库泄露时，攻击者拿到的密码无法直接使用？

**Session / Cookie**

- [ ] Cookie 设置了 HttpOnly、Secure、SameSite？
- [ ] 会话 ID 用密码学安全的随机数生成？
- [ ] 会话有过期时间？长期不活跃的会话会被清理？

**JWT（如果用了）**

- [ ] 有效期短（15 分钟内）？
- [ ] 验证时显式指定算法，不用 token 里的？
- [ ] 校验了 iss 和 aud？
- [ ] 需要撤销时有黑名单机制？
- [ ] token 里没有敏感信息，且体积可控？

**OAuth**

- [ ] 用了 state 参数防 CSRF？
- [ ] client_secret 只在后端？
- [ ] redirect_uri 做了严格校验（防止授权码被劫持）？
- [ ] 每个用户会话独立存储 token？

**授权**

- [ ] 权限检查在服务端，不是只在前端隐藏按钮？
- [ ] 数据范围的限制下推到查询条件里？
- [ ] 认证失败返回 401，权限不足返回 403？
- [ ] 关键操作的日志记录了操作人和时间？

最后一条在合规审计时经常被问到，而且补起来最难 —— **要记录就得从一开始就记**。