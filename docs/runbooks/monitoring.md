# 监控与故障处理手册

## 1. 监控入口

| 路径                | 语义                                  | 访问要求                                                       |
| ------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `/health/live`      | API 进程存活，不检查 PostgreSQL 或 R2 | Nginx 443 可达                                                 |
| `/health/ready`     | 2 秒内同时检查 PostgreSQL 与 R2       | Nginx 仅允许环回或私网来源，并要求 `X-Monitoring-Token`        |
| `/internal/metrics` | Prometheus 文本指标                   | Nginx 返回 404；只能从受控容器网络直连 API，并要求同一监控令牌 |

不要把 API 的 3000 端口发布到宿主机。Prometheus 应加入生产 Compose 的受控网络，抓取 `http://api:3000/internal/metrics` 并通过安全的 header 配置注入 `X-Monitoring-Token`。监控令牌不能出现在抓取 URL、日志或告警正文。

临时人工检查可以在 API 容器内执行，不把令牌展开到宿主机命令历史：

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec -T api \
  node --input-type=module --eval "const r=await fetch('http://127.0.0.1:3000/internal/metrics',{headers:{'x-monitoring-token':process.env.MONITORING_TOKEN}}); if(!r.ok) process.exit(1); process.stdout.write(await r.text())"
```

## 2. 指标目录

API 注册的业务指标均以 `wx_upload_` 开头：

| 指标                                         | 类型/标签                        | 用途                               |
| -------------------------------------------- | -------------------------------- | ---------------------------------- |
| `wx_upload_login_total`                      | counter；`outcome`               | 登录成功/失败率                    |
| `wx_upload_wechat_upstream_duration_seconds` | histogram；`outcome`             | 微信登录上游延迟                   |
| `wx_upload_initializations_total`            | counter；`outcome`               | 上传初始化 accepted/rejected/error |
| `wx_upload_active_uploads`                   | gauge                            | 活跃上传数量                       |
| `wx_upload_bytes_total`                      | counter                          | 已接受上传字节                     |
| `wx_upload_parts_total`                      | counter；`outcome`               | 分片结果                           |
| `wx_upload_part_duration_seconds`            | histogram；`outcome`             | 分片处理延迟                       |
| `wx_upload_part_bytes_total`                 | counter                          | 已接受分片字节                     |
| `wx_upload_part_retries_total`               | counter；`outcome`               | 分片重试                           |
| `wx_upload_part_checksum_mismatches_total`   | counter                          | 哈希不匹配                         |
| `wx_upload_r2_operation_duration_seconds`    | histogram；`operation`,`outcome` | R2 操作延迟                        |
| `wx_upload_r2_operation_errors_total`        | counter；`operation`,`outcome`   | R2 错误与超时                      |
| `wx_upload_finalizer_backlog`                | gauge                            | 等待完成收口的会话                 |
| `wx_upload_finalizer_retries_total`          | counter；`outcome`               | finalizer 重试结果                 |
| `wx_upload_abort_backlog`                    | gauge                            | 等待终止清理的会话                 |
| `wx_upload_abort_retries_total`              | counter；`outcome`               | abort 重试结果                     |
| `wx_upload_reconciliation_total`             | counter；`outcome`               | 对账 confirmed/repaired/failed     |
| `wx_upload_critical_reconciliation_total`    | counter；`code`                  | 存储事实冲突或不可用               |
| `wx_upload_completing_timeouts_total`        | counter                          | 超过完成期限的会话                 |
| `wx_upload_expired_sessions_total`           | counter                          | 过期上传会话                       |

标签值在代码内使用白名单，不能添加 `userId`、昵称、openid、文件名、object key、token 或其他高基数/敏感标签。

## 3. 最低告警规则

下面 PromQL 是单实例起点；多实例部署时保留 `sum` 聚合并按环境标签隔离规则。

### 3.1 五分钟登录错误率超过 5%

```promql
sum(rate(wx_upload_login_total{outcome="error"}[5m]))
/
clamp_min(sum(rate(wx_upload_login_total[5m])), 0.000001)
> 0.05
```

持续 5 分钟后告警。先对比微信上游 P95 与 API 错误日志：

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(wx_upload_wechat_upstream_duration_seconds_bucket[5m]))
)
```

### 3.2 五分钟分片错误率超过 5%

```promql
sum(rate(wx_upload_parts_total{outcome=~"error|checksumMismatch"}[5m]))
/
clamp_min(sum(rate(wx_upload_parts_total[5m])), 0.000001)
> 0.05
```

持续 5 分钟后告警。同时展示重试率、checksum mismatch 与分片 P95，区分网络问题、源文件变化和 R2 问题。

### 3.3 PostgreSQL 或 R2 连续三次 readiness 失败

监控系统每 30 秒从允许的私网来源请求 `/health/ready`。连续 3 次非 200 即告警。readiness 是联合检查，响应不会泄露依赖地址；用以下信号定位：

- R2：`wx_upload_r2_operation_errors_total`、`wx_upload_critical_reconciliation_total`；
- PostgreSQL：JSON 日志中的 `POSTGRES_IDLE_CLIENT_ERROR`、`POSTGRES_UPLOAD_LOCK_CLIENT_ERROR`；
- API 本身：`/health/live`。liveness 同时失败时先处理进程或主机，不要归因于依赖。

### 3.4 完成收口超过 15 分钟

任何完成超时计数增加立即告警：

```promql
increase(wx_upload_completing_timeouts_total[5m]) > 0
```

并用持续 backlog 作为兜底：

```promql
min_over_time(wx_upload_finalizer_backlog[15m]) > 0
```

检查 finalizer retry、R2 complete/head/listParts 错误和关键对账代码。不得直接把 `completing` 标记成功；必须以 R2 事实和应用对账结果收口。

### 3.5 initiating 超过 5 分钟

当前指标没有会话年龄标签，不能用高基数标签绕过。由受控数据库监控集成执行只读年龄检查，禁止复用迁移或维护凭据：

```sql
SELECT count(*) AS stale_initiating
FROM media_app.upload_sessions
WHERE status = 'initiating'
  AND created_at < clock_timestamp() - interval '5 minutes';
```

结果大于 0 即告警，并结合 `wx_upload_reconciliation_total{outcome="failed"}` 与 worker 日志。数据库监控账号应通过单独审批建立只读视图权限，不得注入 API 容器。

### 3.6 备份与恢复

备份系统任一任务失败立即告警；最近成功备份超过 26 小时告警；每月隔离恢复演练未完成或校验失败告警。这些信号来自备份平台，不由 API 指标替代。

## 4. 日志字段与隐私

生产日志为每行一个 JSON。通用请求完成日志必须具备：

- `timestamp`、Pino 数字 `level`、`service=wx-upload-api`、`environment`；
- `requestId`、模板化 `route`、`method`、`statusCode`、`durationMs`；
- 错误时的 `errorCode`、`retryable`；
- worker 失败时的 `worker` 与 `errorCode=WORKER_ITERATION_FAILED`。

业务代码在存在上下文时可记录内部 `userId`、`mediaId`、`uploadId`、`partNumber` 和受控 `upstream` 名称，用于关联审计事件，但不得记录请求 body、原始 headers/query、昵称、openid/unionid、文件名、object key、ETag、Authorization、cookie、token、数据库 URL 或任何 secret。日志清洗器会省略或脱敏这些值，运维日志处理链路不能关闭该处理。

诊断时以响应 `X-Request-Id` 或 `meta.requestId` 为主键检索日志；不要要求用户提供 access/refresh token。用户级状态核对通过数据库审计事件和内部 ID 完成。

## 5. 最小仪表盘

至少包含：

1. liveness、readiness 成功率与连续失败次数；
2. 登录吞吐、错误率、微信上游 P50/P95/P99；
3. 初始化 accepted/rejected/error、活跃上传和上传字节速率；
4. 分片吞吐、错误率、重试、哈希不匹配、P95；
5. 按受控 operation/outcome 聚合的 R2 延迟和错误；
6. finalizer/abort backlog 与重试；
7. 对账 confirmed/repaired/failed、关键代码、完成超时与过期会话；
8. PostgreSQL 连接、磁盘、事务与备份新鲜度（由数据库/备份平台提供）。

## 6. 事件处理顺序

1. 记录告警开始时间、环境和监控快照，不复制任何密钥。
2. 检查 liveness，再检查带令牌的 readiness。
3. 以 requestId 检索结构化日志，确认错误码与受影响路由。
4. 检查 PostgreSQL、R2 与微信状态以及相应业务指标。
5. 上传仍在 `completing` 时让后台对账运行；不要手工创建第二个 multipart 或伪造成功状态。
6. 需要停机时先让 Nginx 摘除流量，再向 API 发送 SIGTERM，等待 worker 与数据库连接关闭。
7. 恢复后验证登录、小文件上传、历史终态、backlog 清零趋势和 readiness，再关闭事件。
