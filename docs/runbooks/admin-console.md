# 上传审计后台

## 1. 用途与访问地址

生产地址为 `https://api.rollinwave.store/admin/`。后台用于人工查看：

- 微信 `openid`、内部用户 ID 与已确认昵称的映射；
- 原始文件名、类型、声明大小与服务器确认接收字节数；
- 上传会话、媒体对象和 R2 交付状态；
- R2 后台任务尝试次数、最后错误码、最后错误时间与下次执行时间；
- 根据持久化事实计算的建议处理动作。

后台不提供素材下载地址，也不能修改上传终态、删除数据库记录或 R2 对象。首版不自动通知用户；是否联系用户由管理员根据“需用户重传”筛选结果人工决定。

## 2. 状态判定

| 后台分类 | 判定依据 | 操作建议 |
| --- | --- | --- |
| 服务器接收中 | 会话仍为 `initiating/uploading` | 等待用户端完成；长期不动再结合过期状态检查 |
| R2 排队重试 | 服务器已确认全部字节，会话为 `completing`，媒体仍为 `pending_upload` | 不要求用户重传；后台队列会继续交付 |
| 已入 R2 | 会话为 `completed` 且媒体为 `ready` | 无需处理 |
| 需用户重传 | 服务器未确认全部字节且会话已 `failed/expired` | 可以联系用户重新选择本地文件上传 |
| 需人工检查 | 服务器已确认全部字节，但会话或媒体已进入失败状态，或状态组合异常 | 检查 upload spool、R2 凭据、网络和 API 日志，不要先要求用户重传 |
| 已取消 | 会话或媒体已取消 | 无需处理 |

“服务器已收到完整文件”与“R2 已完成”是两个独立事实。只要确认字节数等于预期字节数，就不应因临时 R2 故障要求用户重新上传。

## 3. 登录安全

后台使用独立账号和 Scrypt 密码校验串。成功登录后签发 8 小时的 `HttpOnly; Secure; SameSite=Strict` 签名 Cookie。登录按客户端 IP 限制为每分钟 5 次；后台查询按 IP 限制为每分钟 180 次。

所有 `/admin` 响应都包含 `Cache-Control: no-store`、禁止 iframe、禁止搜索引擎收录和严格 CSP。后台页面与 API 同域，不依赖第三方脚本或 CDN。

生产凭据只保存在 `/etc/wx-private-media-upload/production.env`：

```text
ADMIN_USERNAME=<admin-username>
ADMIN_PASSWORD_SCRYPT=<scrypt-verifier>
ADMIN_SESSION_SECRET=<base64url-random-secret>
```

密码校验串与会话密钥生成方法见 [生产密钥与部署手册](production-secrets.md)。禁止把明文密码写入仓库、Compose、运维文档、日志或工单。

## 4. 日常使用

1. 打开后台地址并登录。
2. 先看汇总卡片中的“R2 排队中”“需用户重传”“需人工检查”。
3. 使用状态按钮筛选；可按文件名、昵称、openid、upload UUID 或 media UUID 搜索。
4. “R2 排队中”只需观察后台交付，不联系用户重传。
5. “需人工检查”先结合错误码和 API 日志排查。
6. “需用户重传”表示服务器没有完整文件，可人工联系对应用户。

页面不会自动刷新。需要最新状态时点击“刷新数据”，这只重新读取 PostgreSQL，不会触发上传重试、R2 重试或用户通知。

## 5. 凭据轮换

在受信任终端生成新的 Scrypt 校验串和独立会话密钥，更新受限的生产环境文件后重新创建 API 容器：

```bash
prod_compose up --detach --no-deps --force-recreate api
prod_compose ps
```

随后用新账号密码登录，并确认旧 Cookie 已因会话密钥轮换而失效。不要只执行 `restart api`，因为 restart 不会重新读取环境文件。
