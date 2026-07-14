# 私有素材上传系统接口设计

> 文档状态：待评审
> 版本：v1
> 日期：2026-07-14
> 关联文档：[架构设计](../superpowers/specs/2026-07-14-wechat-private-media-upload-design.md) · [数据库设计](../database/media-upload-database.md)

## 1. 接口范围

本文档定义三类接口：

1. 微信小程序登录与个人资料接口。
2. 私有素材初始化、分片、完成、取消和上传记录接口。
3. 后续采集服务器的任务领取、租约保护的分段内容读取、续租和结果确认接口。

小程序 API 不提供文件读取、预览、公开链接或删除接口。采集服务器不持有 R2 凭据，只能在有效任务租约内通过业务 API 分段读取内容。

## 2. 通用约定

### 2.1 基础约定

- 业务 Base path：`/v1`；健康检查固定在根路径 `/health/*`。生产 Origin 使用用户已具备的 HTTPS 域名，并通过部署变量 `PUBLIC_API_BASE_URL` 注入；小程序不得硬编码测试域名。
- 只允许 HTTPS，生产环境 TLS 最低 1.2。
- JSON 字段使用 `camelCase`。
- 时间使用 UTC RFC 3339，例如 `2026-07-14T09:15:00.000Z`。
- 所有资源 ID 是服务端生成的 UUIDv7；客户端把它当作不透明字符串。
- 字节数使用 JSON 整数，单位为 byte。
- JSON 请求最大 64 KiB；未知字段返回 `422 VALIDATION_ERROR`。
- 所有包含身份、上传状态或采集状态的响应设置 `Cache-Control: no-store`。

除 Collector 内容接口直接返回二进制 `206` 外，其余成功与错误响应遵循本节 JSON envelope；内容接口发生鉴权或 Range 错误时仍返回标准 JSON 错误 envelope。

### 2.2 成功响应

```json
{
  "data": {},
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:15:00.000Z"
  }
}
```

列表响应额外包含：

```json
{
  "meta": {
    "pagination": {
      "limit": 20,
      "hasMore": true,
      "nextCursor": "eyJ2IjoxLCJ0IjoiMjAyNi0wNy0xNFQwOTowMDowMFoifQ"
    }
  }
}
```

### 2.3 错误响应

```json
{
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "单文件不能超过 200 MiB",
    "retryable": false,
    "details": {
      "maxSizeBytes": 209715200,
      "actualSizeBytes": 220200960
    }
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:15:00.000Z"
  }
}
```

客户端只依赖稳定的 `error.code`，不能依赖中文 `message`。

### 2.4 请求追踪

客户端可以传入 UUID：

```http
X-Request-Id: 019bfae5-c06f-77dd-8cf2-b2e0513a6789
```

缺省时服务端生成。响应 Header 和 `meta.requestId` 始终返回最终请求 ID。

### 2.5 用户认证

```http
Authorization: Bearer <access-token>
```

- Access Token 为 Ed25519 签名 JWT，有效期 15 分钟。
- JWT 至少包含 `iss`、`aud`、`sub=userId`、`sid=sessionId`、`iat`、`exp`、`jti` 和 `typ=user`。
- Refresh Token 为 256-bit 高熵不透明字符串，有效期 30 天；数据库只保存 SHA-256 摘要。
- Refresh Token 每次使用后轮换。轮换响应丢失时，客户端重新执行 `wx.login`，不得反复使用旧 Token。
- `openid`、`unionid`、微信 `session_key` 永远不返回客户端。
- 首版不使用微信敏感数据解密，`session_key` 不持久化到数据库或缓存。

### 2.6 采集服务器认证

```http
Authorization: Bearer col_live_<credential-id>_<secret>
```

- API Key 是高熵机器凭据，数据库只保存带服务端 pepper 的 HMAC-SHA256。
- 首版只定义一个机器 scope：`collector:jobs`，所有 Collector 路由都必须具备该 scope；内容、心跳和结果路由还必须通过任务租约校验。
- 用户 JWT 调用采集接口或机器凭据调用用户接口均返回 `403 FORBIDDEN`。
- 领取任务后，工作接口还需携带该次 claim attempt 专属的高熵 bearer 租约 Token：

```http
X-Lease-Token: <opaque-lease-token>
X-Collector-Worker-Id: collector-01
```

`X-Collector-Worker-Id` 必须与 claim 请求中的 `workerId` 完全一致。同一租约 Token 可在租约有效期内重复用于分段读取、heartbeat、complete 或 fail，不在 heartbeat 时轮换；任务重领会生成新 Token，并立即使旧 Token 失效。

### 2.7 幂等

以下接口必须传：

```http
Idempotency-Key: 019bfae6-d170-76cc-9df3-c3f1624b789a
```

- `POST /uploads`
- `POST /uploads/{uploadId}/complete`
- `POST /uploads/{uploadId}/abort`
- `POST /collector/jobs/claim`
- `POST /collector/jobs/{jobId}/heartbeat`
- `POST /collector/jobs/{jobId}/complete`
- `POST /collector/jobs/{jobId}/fail`

规则：

- Key 长度 16–128，只允许 `[A-Za-z0-9._:-]`。
- 唯一范围为“认证主体 + 操作 + Key”。
- 同一 Key 和同一规范化请求返回首次稳定结果，并返回 `Idempotency-Replayed: true`。
- 同一 Key 对应不同请求返回 `409 IDEMPOTENCY_KEY_REUSED`。
- 首次请求仍执行时返回 `409 IDEMPOTENCY_IN_PROGRESS` 与 `Retry-After: 1`。
- 分片接口以 `uploadId + partNumber + chunkSha256` 自然幂等，不要求 Idempotency-Key。

## 3. 文件与上传限制

### 3.1 固定限制

| 项目 | 限制 |
|---|---:|
| 单次选择 | 最多 9 个文件 |
| 单文件最小值 | 12 bytes；同时必须通过格式签名校验 |
| 单文件最大值 | 209,715,200 bytes（200 MiB） |
| 固定分片 | 8,388,608 bytes（8 MiB） |
| 最大分片数 | 25 |
| 非最后分片 | 必须恰好 8 MiB |
| 最后分片 | 1 byte 至 8 MiB |
| 文件名 | UTF-8 1–255 bytes |
| 每上传并行分片 | 最多 2 个 |
| 每用户并行分片 | 最多 4 个 |
| 每用户未完成上传 | 最多 5 个 |
| 上传写入期限 | 创建后 24 小时；截止后不接受新分片或新的 complete，已进入 finalizing 的会话先对账而不直接过期 |

```text
partCount = ceil(sizeBytes / 8388608)
```

### 3.2 文件白名单

| 类别 | MIME | 可接受扩展名 | 规范扩展名 |
|---|---|---|---|
| image | `image/jpeg` | `.jpg`, `.jpeg` | `.jpg` |
| image | `image/png` | `.png` | `.png` |
| image | `image/webp` | `.webp` | `.webp` |
| image | `image/gif` | `.gif` | `.gif` |
| image | `image/heic`, `image/heif` | `.heic`, `.heif` | 原类型 |
| video | `video/mp4` | `.mp4`, `.m4v` | `.mp4` |
| video | `video/quicktime` | `.mov` | `.mov` |

服务端必须检查声明 MIME、扩展名和首片 magic bytes。拒绝 SVG、HTML、脚本、压缩包、音频和可执行文件。`application/octet-stream` 不能作为初始化时的文件 MIME。

原文件名只作为展示元数据：必须取 basename，禁止 `/`、`\`、NUL、控制字符、`.` 和 `..`。R2 object key 完全由服务端生成。

## 4. 接口清单

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/health/live` | 无 | 进程存活检查 |
| GET | `/health/ready` | 内网或监控 | PostgreSQL 与 R2 就绪检查 |
| POST | `/v1/auth/wechat-login` | 无 | 微信 code2Session 登录 |
| POST | `/v1/auth/refresh` | Refresh Token | 轮换登录令牌 |
| POST | `/v1/auth/logout` | 用户 JWT | 撤销登录会话 |
| GET | `/v1/profile` | 用户 JWT | 获取当前用户资料 |
| PUT | `/v1/profile/nickname` | 用户 JWT | 确认或更新昵称 |
| POST | `/v1/uploads` | 用户 JWT | 初始化分片上传 |
| GET | `/v1/uploads` | 用户 JWT | 上传记录列表 |
| GET | `/v1/uploads/{uploadId}` | 用户 JWT | 获取上传与分片状态 |
| POST | `/v1/uploads/{uploadId}/parts/{partNumber}` | 用户 JWT | 上传一个分片 |
| POST | `/v1/uploads/{uploadId}/complete` | 用户 JWT | 提交完成 |
| POST | `/v1/uploads/{uploadId}/abort` | 用户 JWT | 中止未完成上传 |
| POST | `/v1/collector/jobs/claim` | `collector:jobs` | 领取采集任务 |
| GET | `/v1/collector/jobs/{jobId}/content` | `collector:jobs` + 租约 | 按 Range 读取私有内容 |
| POST | `/v1/collector/jobs/{jobId}/heartbeat` | `collector:jobs` + 租约 | 延长租约 |
| POST | `/v1/collector/jobs/{jobId}/complete` | `collector:jobs` + 租约 | 确认采集成功 |
| POST | `/v1/collector/jobs/{jobId}/fail` | `collector:jobs` + 租约 | 确认采集失败 |

不属于当前用户的资源统一返回 `404`，不暴露资源是否存在。

### 4.1 健康检查语义

- `GET /health/live` 只检查进程和事件循环，正常返回 `200 {"status":"ok"}`；不得因 PostgreSQL、微信或 R2 故障而失败。
- `GET /health/ready` 在 2 秒预算内检查 PostgreSQL 简单查询和 R2 `HeadBucket`，全部正常返回 `200 {"status":"ready"}`，否则返回 `503` 并只列依赖名称与状态，不返回地址或凭据。
- `ready` 仅允许内网、负载均衡器或带独立监控认证的来源访问；两个健康接口都不写业务审计事件。

## 5. 登录与资料接口

### 5.1 微信登录

```http
POST /v1/auth/wechat-login
Content-Type: application/json
```

请求：

```json
{
  "code": "0a3xYp0000J6dR1ABCDEF9",
  "deviceId": "5f8b68e8-4d4a-4df0-a7d1-3db4dcbcc001"
}
```

规则：

- `code` 长度 1–128，后端使用固定 AppID 与 AppSecret 调用微信 `code2Session`。
- 按 `(appId, openid)` 查询或创建内部用户。
- 登录请求失败且结果未知时，客户端重新调用 `wx.login` 获取新 code。
- `deviceId` 是客户端生成的不透明安装标识，长度 1–128，仅用于会话风控，不是用户身份。

响应 `200`：

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJFZERTQSJ9.payload.signature",
    "accessTokenExpiresIn": 900,
    "refreshToken": "rft_5hM2J1K4pQ8xW7vN3sR9...",
    "refreshTokenExpiresIn": 2592000,
    "isNewUser": true,
    "user": {
      "id": "019bfae0-7b1a-7c32-89fd-6dfb0ce51234",
      "nickname": null,
      "nicknameConfirmed": false,
      "createdAt": "2026-07-14T09:15:00.000Z"
    }
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:15:00.000Z"
  }
}
```

主要错误：`WECHAT_CODE_INVALID`、`WECHAT_SERVICE_UNAVAILABLE`、`USER_DISABLED`。

### 5.2 刷新令牌

```http
POST /v1/auth/refresh
Content-Type: application/json
```

请求：

```json
{
  "refreshToken": "rft_5hM2J1K4pQ8xW7vN3sR9..."
}
```

响应 `200` 返回新的 Access Token 和 Refresh Token，并立刻撤销旧 Refresh Token：

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJFZERTQSJ9.new-payload.signature",
    "accessTokenExpiresIn": 900,
    "refreshToken": "rft_8nV2cQ6mT1yL4pW7...",
    "refreshTokenExpiresIn": 2592000
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:16:00.000Z"
  }
}
```

发现已使用 Token 重放时撤销同一 token family，并返回 `401 REFRESH_TOKEN_REUSED`。

### 5.3 退出登录

```http
POST /v1/auth/logout
Authorization: Bearer <access-token>
Content-Type: application/json
```

请求：

```json
{
  "refreshToken": "rft_5hM2J1K4pQ8xW7vN3sR9..."
}
```

服务端只撤销属于 Access Token 当前 `sub` 的 Refresh Session；不存在、不属于当前用户或已撤销时都返回 `204 No Content`，避免暴露会话信息。重复退出也返回 `204`。

### 5.4 获取个人资料

```http
GET /v1/profile
Authorization: Bearer <access-token>
```

响应 `200`：

```json
{
  "data": {
    "user": {
      "id": "019bfae0-7b1a-7c32-89fd-6dfb0ce51234",
      "nickname": "小晴",
      "nicknameConfirmed": true,
      "nicknameConfirmedAt": "2026-07-14T09:17:12.000Z",
      "createdAt": "2026-07-14T09:15:00.000Z",
      "updatedAt": "2026-07-14T09:17:12.000Z"
    }
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:17:15.000Z"
  }
}
```

### 5.5 确认或更新昵称

小程序只在用户完成 `<input type="nickname">` 确认后调用：

```http
PUT /v1/profile/nickname
Authorization: Bearer <access-token>
Content-Type: application/json
```

请求：

```json
{
  "nickname": "小晴",
  "source": "wechatNicknameInput",
  "confirmed": true
}
```

规则：

- `source` 必须为 `wechatNicknameInput`，`confirmed` 必须为 `true`。
- 昵称执行 Unicode NFC 和首尾空白清理。
- 长度 1–32 个 grapheme cluster，UTF-8 不超过 128 bytes。
- 禁止换行、C0/C1 控制字符和双向文本控制字符；允许正常 emoji。
- 昵称可重复、可更新，服务端使用自己的时间作为确认时间。
- 该组件不提供后端可验证签名，因此昵称是用户确认资料，不是身份凭证。

响应 `200` 返回更新后的 `user`。首次上传前未确认昵称时，初始化上传返回 `428 NICKNAME_REQUIRED`。

## 6. 上传接口

### 6.1 初始化上传

```http
POST /v1/uploads
Authorization: Bearer <access-token>
Content-Type: application/json
Idempotency-Key: 019bfae6-d170-76cc-9df3-c3f1624b789a
```

请求：

```json
{
  "fileName": "summer-video.mov",
  "kind": "video",
  "mimeType": "video/quicktime",
  "sizeBytes": 12582913
}
```

初始化流程：

1. 检查昵称、文件名、MIME、大小和活跃会话数量。
2. 创建媒体记录、R2 object key 和 multipart upload。
3. 返回固定分片计划；R2 multipart upload ID 和 object key 不返回客户端。

响应 `201`：

```json
{
  "data": {
    "upload": {
      "id": "019bfae2-9d3c-7a10-89df-8fbd2e073456",
      "mediaId": "019bfae1-8c2b-7b21-98ce-7eac1df62345",
      "status": "uploading",
      "fileName": "summer-video.mov",
      "kind": "video",
      "mimeType": "video/quicktime",
      "sizeBytes": 12582913,
      "partSizeBytes": 8388608,
      "partCount": 2,
      "expiresAt": "2026-07-15T09:20:00.000Z",
      "createdAt": "2026-07-14T09:20:00.000Z"
    },
    "parts": [
      {
        "partNumber": 1,
        "offsetBytes": 0,
        "sizeBytes": 8388608,
        "status": "pending"
      },
      {
        "partNumber": 2,
        "offsetBytes": 8388608,
        "sizeBytes": 4194305,
        "status": "pending"
      }
    ]
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:20:00.000Z"
  }
}
```

### 6.2 上传分片

该接口专供 `wx.uploadFile`。小程序先用文件系统 `open/read` 读取指定范围，计算 SHA-256，写入一个临时分片文件，再上传：

```http
POST /v1/uploads/{uploadId}/parts/{partNumber}
Authorization: Bearer <access-token>
Content-Type: multipart/form-data; boundary=<runtime-generated>
X-Chunk-SHA256: <64-char-lowercase-hex>
```

Multipart 字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `chunk` | file | 是 | 当前分片文件，仅允许一个文件字段 |
| `chunkSizeBytes` | decimal string | 是 | 当前分片的原始字节数 |

小程序调用示例：

```ts
wx.uploadFile({
  url: `${apiBase}/v1/uploads/${uploadId}/parts/${partNumber}`,
  filePath: temporaryChunkPath,
  name: 'chunk',
  header: {
    Authorization: `Bearer ${accessToken}`,
    'X-Chunk-SHA256': chunkSha256,
  },
  formData: {
    chunkSizeBytes: String(chunkSizeBytes),
  },
})
```

服务端规则：

- 第 1 片必须先成功，用于 magic-byte 校验；之后可并发两个不同 part number。
- 非最后分片必须恰好 8 MiB；最后一片必须等于计划大小。
- 服务端流式计算实际 SHA-256，并与 Header 比较。
- 相同 part number、大小和哈希重复提交直接返回已确认结果。
- 同 part number 正在处理时返回 `409 PART_UPLOAD_IN_PROGRESS`。
- 状态进入 `completing` 后不再接受分片。
- `serverTime >= expiresAt` 时不再接受新分片，返回 `410 UPLOAD_EXPIRED` 并触发安全终止。
- 服务端将文件字段流式写入 R2 `UploadPart`，不把整个分片转成进程级 Buffer。

响应 `200`：

```json
{
  "data": {
    "part": {
      "partNumber": 1,
      "sizeBytes": 8388608,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "status": "uploaded",
      "uploadedAt": "2026-07-14T09:21:08.000Z"
    },
    "progress": {
      "confirmedBytes": 8388608,
      "totalBytes": 12582913,
      "uploadedParts": 1,
      "totalParts": 2,
      "percent": 66.67
    },
    "replayed": false
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:21:08.000Z"
  }
}
```

客户端用 `UploadTask.onProgressUpdate` 汇总所有尚未确认的在途分片：

```text
displayBytes = authoritativeConfirmedBytes
             + Σ min(inFlightPart.sentBytes, inFlightPart.expectedBytes)
percent = min(100, displayBytes / totalBytes × 100)
```

分片响应到达时先移除对应 `inFlight` 项，再用
`max(当前 authoritativeConfirmedBytes, 响应 confirmedBytes)` 更新权威值，避免两个并发响应乱序导致回退或重复计数。刷新或恢复后以服务端确认字节重新建立基线。

### 6.3 获取上传状态

```http
GET /v1/uploads/{uploadId}
Authorization: Bearer <access-token>
```

响应 `200`：

```json
{
  "data": {
    "upload": {
      "id": "019bfae2-9d3c-7a10-89df-8fbd2e073456",
      "mediaId": "019bfae1-8c2b-7b21-98ce-7eac1df62345",
      "status": "uploading",
      "fileName": "summer-video.mov",
      "kind": "video",
      "mimeType": "video/quicktime",
      "sizeBytes": 12582913,
      "progress": {
        "confirmedBytes": 8388608,
        "totalBytes": 12582913,
        "uploadedParts": 1,
        "totalParts": 2,
        "percent": 66.67
      },
      "expiresAt": "2026-07-15T09:20:00.000Z",
      "failure": null,
      "createdAt": "2026-07-14T09:20:00.000Z",
      "updatedAt": "2026-07-14T09:21:08.000Z"
    },
    "partDetailsRetained": true,
    "partsAvailableUntil": null,
    "parts": [
      {
        "partNumber": 1,
        "offsetBytes": 0,
        "sizeBytes": 8388608,
        "status": "uploaded",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      {
        "partNumber": 2,
        "offsetBytes": 8388608,
        "sizeBytes": 4194305,
        "status": "pending",
        "sha256": null
      }
    ],
    "pollAfterSeconds": 2
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:21:10.000Z"
  }
}
```

活跃会话中，此接口是断点续传的事实来源；客户端只在上传聚合状态为 `uploading` 时重传 `status=pending` 的分片。`uploaded` 和 `verified` 都表示无需重传，`verified` 表示完成前已与 R2 ListParts 复核。

终态上传摘要和 `uploadId` 长期保留。活跃会话的 `partsAvailableUntil=null`；进入终态时设置为 `terminalAt + 90 days`。截止后 `partDetailsRetained=false`、`partsAvailableUntil` 保持原截止时间且 `parts=[]`，详情与历史记录仍返回 `200`。

冷启动时只有原微信临时路径仍可读取，并且所有已上传分片的本地 SHA-256 与这里返回的哈希逐片匹配，才能继续旧会话。路径失效或任一不匹配时，客户端必须以 `reason=replaced` 中止旧上传，让用户重新选择、二次确认并调用 `POST /v1/uploads` 创建新记录；重新选择的文件不能拼接到旧会话。

### 6.4 完成上传

```http
POST /v1/uploads/{uploadId}/complete
Authorization: Bearer <access-token>
Content-Type: application/json
Idempotency-Key: 019bfae7-e281-75bb-aef4-d402735c89ab
```

请求体为空对象：

```json
{}
```

请求处理器只接受 `serverTime < expiresAt` 的 `uploading` 会话，校验数据库分片连续并把会话持久化为 `completing`。持久化后台 finalizer 每秒只扫描 `nextFinalizeAt` 已到期的候选，对 `uploadId` 取得 PostgreSQL session-level advisory lock 后，先 `HEAD` 固定对象键：对象已存在且大小正确时直接补齐数据库，否则依据数据库分片记录执行 `ListParts`、`CompleteMultipartUpload` 与最终 `HEAD`；客户端不提交 ETag 清单。失败次数、错误和下一次执行时间持久化，并以最大 5 分钟 full-jitter 退避。即使 API 进程在返回后退出，其他实例或重启后的扫描也会继续处理。

正常响应 `202`：

```json
{
  "data": {
    "upload": {
      "id": "019bfae2-9d3c-7a10-89df-8fbd2e073456",
      "status": "finalizing",
      "progress": {
        "confirmedBytes": 12582913,
        "totalBytes": 12582913,
        "percent": 100
      }
    },
    "pollAfterSeconds": 2
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:23:00.000Z"
  }
}
```

完成后查询状态返回 `awaiting_collection`。GET 状态中的 `pollAfterSeconds` 根据下一次 finalizer 时间计算并限制在 2–30 秒，客户端无需高频轮询。分片不齐返回 `409 PARTS_INCOMPLETE`，`details.missingPartNumbers` 列出缺失片。

### 6.5 中止上传

```http
POST /v1/uploads/{uploadId}/abort
Authorization: Bearer <access-token>
Content-Type: application/json
Idempotency-Key: 019bfae8-f392-74aa-bf05-e513846d9abc
```

请求：

```json
{
  "reason": "userCancelled"
}
```

`reason` 允许 `userCancelled` 或 `replaced`。仅 `initiating/uploading` 可以中止；该接口不删除已完成对象。

响应 `202` 返回用户聚合状态 `status=cancelling`，最终查询为 `aborted`。已中止记录重复调用返回原结果。

### 6.6 上传记录列表

```http
GET /v1/uploads?limit=20&status=awaiting_collection&cursor=<opaque>
Authorization: Bearer <access-token>
```

参数：

- `limit`：1–100，默认 20。
- `status`：可省略；只能传一个用户聚合状态。
- `cursor`：不透明且带服务端签名，绑定当前用户和过滤条件。
- 排序固定为 `createdAt DESC, id DESC`，不返回总数。

响应 `200`：

```json
{
  "data": {
    "items": [
      {
        "id": "019bfae2-9d3c-7a10-89df-8fbd2e073456",
        "mediaId": "019bfae1-8c2b-7b21-98ce-7eac1df62345",
        "status": "awaiting_collection",
        "fileName": "summer-video.mov",
        "kind": "video",
        "mimeType": "video/quicktime",
        "sizeBytes": 12582913,
        "progress": {
          "confirmedBytes": 12582913,
          "totalBytes": 12582913,
          "percent": 100
        },
        "failure": null,
        "createdAt": "2026-07-14T09:20:00.000Z",
        "updatedAt": "2026-07-14T09:23:03.000Z"
      }
    ]
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:30:00.000Z",
    "pagination": {
      "limit": 20,
      "hasMore": false,
      "nextCursor": null
    }
  }
}
```

用户聚合状态：

```text
uploading | finalizing | cancelling | awaiting_collection | collecting | collected |
upload_failed | collection_failed | aborted | expired
```

历史列表由长期保留的媒体记录与上传会话摘要生成，不依赖 90 天后会删除的分片明细。

用户响应会返回续传所需的业务 `upload.id`，但不包含 R2 bucket、object key、R2 multipart upload ID、ETag、签名 URL 或读取接口。

## 7. 采集接口

### 7.1 领取任务

```http
POST /v1/collector/jobs/claim
Authorization: Bearer <collector-api-key>
Content-Type: application/json
Idempotency-Key: 019bfae9-04a3-7399-8016-f624957eabcd
```

请求：

```json
{
  "workerId": "collector-01",
  "maxJobs": 2,
  "acceptedKinds": ["image", "video"]
}
```

约束：

- `workerId` 为 1–64 个 `[A-Za-z0-9._:-]` 字符。
- `maxJobs` 为 1–10，默认 1。
- 每个机器凭据配置 `maxActiveJobs=1–10`，生产默认 10；请求不能突破该凭据额度。
- claim 事务先 `FOR UPDATE` 锁定凭据行并统计该凭据的有效租约，再以剩余额度使用 `FOR UPDATE SKIP LOCKED` 原子领取任务；同一凭据的并发 claim 因此不会超发。租约固定 5 分钟。
- 没有任务时返回空数组，不返回 `204`。

响应 `200`：

```json
{
  "data": {
    "jobs": [
      {
        "jobId": "019bfae3-ae4d-79ff-a9e0-90ce3f184567",
        "attempt": 1,
        "leaseToken": "lse_R6jP5cM1kQv6eNf0AuZgtYDY8tJs9A2W",
        "leaseExpiresAt": "2026-07-14T09:35:00.000Z",
        "attemptDeadlineAt": "2026-07-14T10:00:00.000Z",
        "uploader": {
          "userId": "019bfae0-7b1a-7c32-89fd-6dfb0ce51234",
          "nickname": "小晴"
        },
        "source": {
          "mediaId": "019bfae1-8c2b-7b21-98ce-7eac1df62345",
          "fileName": "summer-video.mov",
          "kind": "video",
          "mimeType": "video/quicktime",
          "sizeBytes": 12582913,
          "contentPath": "/v1/collector/jobs/019bfae3-ae4d-79ff-a9e0-90ce3f184567/content",
          "maxRangeBytes": 8388608
        }
      }
    ],
    "retryAfterSeconds": null
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:30:00.000Z"
  }
}
```

claim 不返回 bucket、object key、R2 凭据、签名 URL 或公开 URL。`contentPath` 是普通受保护 API 路径，必须与当前机器凭据和租约 Token 一起使用。

### 7.2 分段读取私有内容

```http
GET /v1/collector/jobs/{jobId}/content
Authorization: Bearer <collector-api-key>
X-Lease-Token: <lease-token>
X-Collector-Worker-Id: collector-01
Range: bytes=0-8388607
```

规则：

- 必须具有 `collector:jobs`，且机器凭据 ID、`jobId`、`X-Collector-Worker-Id` 和租约 Token 摘要必须与当前租约匹配；每个请求开始时租约必须仍有效。
- 必须使用单一闭区间 byte Range，单次最多 8,388,608 bytes；不接受多 Range。文件不超过 8 MiB 时也建议显式传 Range。
- API 用服务端 R2 凭据执行对应 Range GET 并直接流式转发，不把内容写入磁盘或整段读入内存。
- 响应流的硬截止时间取“请求开始时读取到的 `leaseExpiresAt`”与 180 秒上限的较早值；后续 heartbeat 不延长已经开始的响应。超时后 Collector 续租并从同一 Range 重新请求。
- 正常返回 `206 Partial Content`，携带 `Content-Range`、准确 `Content-Length`、`Accept-Ranges: bytes`、已验证 MIME 和 `Cache-Control: no-store`。
- Collector 依次读取至 `sizeBytes - 1`，每 60 秒并行 heartbeat，并自行增量计算完整 SHA-256。
- 租约丢失返回 `409 LEASE_LOST`；范围非法或越界返回 `416 RANGE_NOT_SATISFIABLE`；范围超过 8 MiB 返回 `416 RANGE_TOO_LARGE`。

### 7.3 心跳

采集端每 60 秒调用：

```http
POST /v1/collector/jobs/{jobId}/heartbeat
Authorization: Bearer <collector-api-key>
X-Lease-Token: <lease-token>
X-Collector-Worker-Id: collector-01
Content-Type: application/json
Idempotency-Key: 019bfaea-15b4-7288-9127-0735a68fbcde
```

请求体 `{}`。成功后把租约更新为 `serverNow + 5 minutes`，但不能超过当前 attempt 的 30 分钟截止时间。

响应 `200`：

```json
{
  "data": {
    "jobId": "019bfae3-ae4d-79ff-a9e0-90ce3f184567",
    "status": "leased",
    "leaseExpiresAt": "2026-07-14T09:40:00.000Z",
    "attemptDeadlineAt": "2026-07-14T10:00:00.000Z"
  },
  "meta": {
    "requestId": "019bfae5-c06f-77dd-8cf2-b2e0513a6789",
    "serverTime": "2026-07-14T09:35:00.000Z"
  }
}
```

心跳不能恢复过期租约；租约失效返回 `409 LEASE_LOST`。

### 7.4 成功确认

```http
POST /v1/collector/jobs/{jobId}/complete
Authorization: Bearer <collector-api-key>
X-Lease-Token: <lease-token>
X-Collector-Worker-Id: collector-01
Content-Type: application/json
Idempotency-Key: 019bfaeb-26c5-7177-a238-1846b790cdef
```

请求：

```json
{
  "observedSizeBytes": 12582913,
  "observedSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "resultRef": "material-20260714-000184",
  "resultMetadata": {
    "collectorNode": "collector-01"
  }
}
```

规则：

- `observedSizeBytes` 必须等于对象元数据大小。
- `observedSha256` 是完整下载字节的 SHA-256。
- `resultRef` 长度 1–1024，是采集系统内部回执，不是公开地址。
- `resultMetadata` 必须是 JSON object，序列化后不超过 16 KiB，不得包含 Token 或 R2 凭据。
- 在同一事务中把任务设为 `succeeded`，并写入媒体 `collectedAt` 与审计记录。
- 相同结果重复提交返回成功；不同结果返回 `409 JOB_ALREADY_FINALIZED`。

响应 `200` 返回 `status=collected` 和 `completedAt`。

### 7.5 失败确认

```http
POST /v1/collector/jobs/{jobId}/fail
Authorization: Bearer <collector-api-key>
X-Lease-Token: <lease-token>
X-Collector-Worker-Id: collector-01
Content-Type: application/json
Idempotency-Key: 019bfaec-37d6-7066-b349-2957c8a1def0
```

请求：

```json
{
  "code": "FINAL_IMPORT_UNAVAILABLE",
  "message": "最终采集目标暂时不可用",
  "retryable": true,
  "retryAfterSeconds": 120
}
```

规则：

- `code` 匹配 `[A-Z][A-Z0-9_]{2,63}`。
- `message` 长度 1–1000，用户侧只显示清理后的概述。
- `retryAfterSeconds` 仅在可重试时允许，范围 5–21,600。
- 未指定时使用 `min(30 × 2^(attempt-1), 21600)` 秒并加入 0–20% 抖动。
- 最多 5 次 attempt；不可重试或达到次数上限后进入 `dead`，用户聚合状态为 `collection_failed`。

响应 `200` 返回 `retry_wait + nextAttemptAt`，或终态 `dead`。

## 8. 状态机

### 8.1 用户聚合状态转换

| 当前状态 | 可进入状态 | 触发条件 |
|---|---|---|
| `uploading` | `finalizing` | 所有分片已确认并请求 complete |
| `uploading` | `cancelling` | 用户中止或会话过期并开始清理 |
| `cancelling` | `aborted` | 用户中止清理完成 |
| `cancelling` | `expired` | 超时会话清理完成 |
| `uploading` | `upload_failed` | 文件校验或 R2 分片不可恢复失败 |
| `finalizing` | `awaiting_collection` | R2 完成并 HEAD 验证成功 |
| `finalizing` | `upload_failed` | 对账确认不可恢复失败 |
| `finalizing` | `cancelling` | HEAD 明确对象不存在、multipart 未完成且写入期限已过 |
| `awaiting_collection` | `collecting` | 采集任务被领取 |
| `collecting` | `awaiting_collection` | 可重试失败或租约过期 |
| `collecting` | `collected` | 采集成功确认 |
| `collecting` | `collection_failed` | 不可重试、达到 5 次上限或管理员取消 |

终态：`collected`、`upload_failed`、`collection_failed`、`aborted`、`expired`。

### 8.2 失败对象

```json
{
  "failure": {
    "stage": "upload",
    "code": "PART_CHECKSUM_MISMATCH",
    "message": "文件分片校验失败",
    "failedAt": "2026-07-14T09:38:00.000Z"
  }
}
```

`stage` 只能为 `validation`、`upload`、`storage` 或 `collector`。

## 9. 超时、并发与重试

| 操作 | 服务端时限 |
|---|---:|
| 普通 JSON 接口 | 10 秒 |
| 微信 code2Session | 连接 2 秒，总时限 5 秒 |
| 分片 POST | 请求空闲 30 秒，总时限 180 秒 |
| R2 UploadPart | 150 秒 |
| 后台 R2 Complete/HEAD | 单次 30 秒；超时继续对账 |
| Collector 内容 Range | 单段最大 8 MiB；空闲 30 秒，总时限 180 秒 |
| 上传写入期限 | 24 小时；finalizing 不按年龄直接终止 |
| 采集租约 | 5 分钟 |
| 采集 attempt | 30 分钟 |

可自动重试：网络错误、`408`、`429`、`502`、`503`、`504`，以及错误体明确标记 `retryable=true` 的响应；`409` 或 `500` 只有在该标志为 true 时重试。使用 full-jitter 指数退避：

```text
delay = random(0, min(2^retryIndex, 30)) seconds
```

`retryIndex` 从 0 开始，只统计首次请求之后的自动重试。

规则：

- 分片最多自动重试 5 次；继续失败时保留 uploadId，稍后恢复。
- `401 TOKEN_EXPIRED`：先刷新 Token；刷新失败则重新 `wx.login`。
- 幂等接口重试必须复用原 Idempotency-Key。
- `complete` 返回 202 后按 `pollAfterSeconds` 查询状态，不能不断使用新 Key 重提。
- `429` 和 `503` 返回整数秒 `Retry-After`。

## 10. 错误码

| HTTP | Code | 可重试 | 含义 |
|---:|---|:---:|---|
| 400 | `INVALID_JSON` | 否 | JSON 无法解析 |
| 400 | `INVALID_CURSOR` | 否 | 游标无效或过滤条件改变 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 否 | 缺少幂等 Key |
| 401 | `UNAUTHORIZED` | 否 | 缺少或无效认证 |
| 401 | `TOKEN_EXPIRED` | 是 | Access Token 过期 |
| 401 | `REFRESH_TOKEN_INVALID` | 否 | Refresh Token 无效或过期 |
| 401 | `REFRESH_TOKEN_REUSED` | 否 | 检测到已轮换 Token 重用 |
| 401 | `WECHAT_CODE_INVALID` | 否 | 微信 code 无效或已使用 |
| 401 | `COLLECTOR_UNAUTHORIZED` | 否 | 采集机器凭据无效 |
| 403 | `FORBIDDEN` | 否 | 凭据类型或 scope 不允许 |
| 403 | `USER_DISABLED` | 否 | 用户被禁用 |
| 404 | `UPLOAD_NOT_FOUND` | 否 | 上传不存在或不属于用户 |
| 404 | `JOB_NOT_FOUND` | 否 | 任务不存在 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 否 | 同 Key 请求内容不同 |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | 是 | 原幂等请求仍在执行 |
| 409 | `FIRST_PART_REQUIRED` | 否 | 首片尚未验证 |
| 409 | `PART_UPLOAD_IN_PROGRESS` | 是 | 同一分片正在上传 |
| 409 | `PARTS_INCOMPLETE` | 否 | 分片不完整 |
| 409 | `UPLOAD_NOT_WRITABLE` | 否 | 当前状态不允许上传分片 |
| 409 | `UPLOAD_NOT_ABORTABLE` | 否 | 当前状态不允许中止 |
| 409 | `LEASE_LOST` | 否 | 采集租约无效或已过期 |
| 409 | `JOB_ALREADY_FINALIZED` | 否 | 任务已用不同结果完成 |
| 410 | `UPLOAD_EXPIRED` | 否 | 上传会话已过期 |
| 413 | `FILE_TOO_LARGE` | 否 | 文件超过 200 MiB |
| 413 | `PART_TOO_LARGE` | 否 | 请求分片超过上限 |
| 415 | `FILE_TYPE_NOT_ALLOWED` | 否 | 类型不在白名单 |
| 415 | `MIME_MISMATCH` | 否 | MIME、扩展名和 magic bytes 不匹配 |
| 416 | `RANGE_NOT_SATISFIABLE` | 否 | 内容 Range 语法非法或越界 |
| 416 | `RANGE_TOO_LARGE` | 否 | 单次内容 Range 超过 8 MiB |
| 422 | `VALIDATION_ERROR` | 否 | 字段格式或未知字段错误 |
| 422 | `FILE_TOO_SMALL` | 否 | 文件不足 12 bytes 或不足以完成格式签名校验 |
| 422 | `NICKNAME_INVALID` | 否 | 昵称不符合规则 |
| 422 | `PART_NUMBER_INVALID` | 否 | 分片编号无效 |
| 422 | `PART_LENGTH_MISMATCH` | 否 | 分片长度与计划不符 |
| 422 | `PART_CHECKSUM_MISMATCH` | 是 | 分片 SHA-256 不一致 |
| 422 | `COLLECTED_SIZE_MISMATCH` | 否 | 采集字节数与对象不一致 |
| 428 | `NICKNAME_REQUIRED` | 否 | 首次上传前未确认昵称 |
| 429 | `UPLOAD_SESSION_LIMIT` | 是 | 未完成上传数量超限 |
| 429 | `UPLOAD_CONCURRENCY_LIMIT` | 是 | 分片并发超限 |
| 429 | `COLLECTOR_LEASE_LIMIT` | 是 | 有效采集租约超限 |
| 429 | `RATE_LIMITED` | 是 | 请求频率超限 |
| 500 | `INTERNAL_ERROR` | 是 | 未分类服务端错误 |
| 503 | `WECHAT_SERVICE_UNAVAILABLE` | 是 | 微信服务暂时不可用 |
| 503 | `STORAGE_UNAVAILABLE` | 是 | R2 暂时不可用 |
| 504 | `UPSTREAM_TIMEOUT` | 是 | 上游请求超时 |

## 11. 速率限制

默认生产限额：

| 接口组 | 限额 |
|---|---|
| 微信登录 | 每 IP 10 次/分钟 |
| 普通用户 JSON API | 每用户 120 次/分钟 |
| 初始化上传 | 每用户 10 次/分钟，且最多 5 个未完成会话 |
| 分片上传 | 每用户最多 4 个并发请求 |
| 上传记录 | 每用户 60 次/分钟 |
| Collector claim | 每凭据 30 次/分钟 |
| Collector 内容读取 | 每凭据最多 8 个并发 Range 请求，并设置带宽上限 |
| Collector heartbeat/结果 | 每凭据 120 次/分钟 |

## 12. 隐私与日志约束

- 用户 API 响应和日志不得包含 `openid`、`unionid`、`session_key`、R2 object key、R2 凭据或内部 ETag。
- Collector API 和日志都不返回或记录 object key、R2 凭据；内容接口访问日志只记录 jobId、Range 与字节数，不记录响应内容。
- Access Token、Refresh Token、机器 Key 和租约 Token 必须在日志与 APM 中脱敏。
- 上传文件内容和昵称不进入普通应用日志；昵称变更只记录用户 ID、事件类型和时间。
- 所有状态变更写审计事件并关联 `requestId`。
