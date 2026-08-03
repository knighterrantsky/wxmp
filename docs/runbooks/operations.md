# 生产运维文档

本文档用于当前微信私有素材上传系统的日常巡检、发布、备份、恢复、证书与密钥轮换及故障处理。默认操作系统为 Ubuntu 24.04，执行账号为 `root` 或受控的 `wxdeploy`。

## 1. 生产资源清单

| 资源 | 标识或位置 |
| --- | --- |
| 服务器 | `117.72.174.2` |
| API | `https://api.rollinwave.store` |
| SSH 密钥 | 运维人员本机 `~/.ssh/jdcloud.pem` |
| Compose project | `wx-private-media-upload-production` |
| 发布根目录 | `/opt/wx-private-media-upload` |
| 当前 release | `/opt/wx-private-media-upload/current` |
| 发布状态 | `/opt/wx-private-media-upload/release.env` |
| 历史 release | `/opt/wx-private-media-upload/releases/<commit-sha>` |
| 生产环境变量 | `/etc/wx-private-media-upload/production.env` |
| TLS 证书 | `/etc/wx-private-media-upload/tls/origin.crt` |
| TLS 私钥 | `/etc/wx-private-media-upload/tls/origin.key` |
| Certbot lineage | `/etc/letsencrypt/live/api.rollinwave.store` |
| 续期部署钩子 | `/etc/letsencrypt/renewal-hooks/deploy/50-wx-upload-nginx` |
| GitHub runner 用户 | `wxdeploy` |
| runner 服务 | `actions.runner.knighterrantsky-wxmp.wx-upload-production.service` |

生产数据分为两部分：PostgreSQL 保存用户映射、上传会话和历史状态；Cloudflare R2 保存私有图片/视频对象。数据库备份不能替代 R2 数据保护，R2 同步也不能替代数据库备份。

## 2. 操作原则

- 正常发布只通过 GitHub Actions，从 `main` 交付不可变 SHA。
- 禁止在生产服务器直接修改 release 文件、构建镜像或检出未审核源码。
- 禁止删除 `postgres-data` volume 处理普通启动故障。
- 禁止手工把 `completing` 上传改成成功；必须由 R2 事实和后台对账收口。
- 禁止把 `production.env`、`docker inspect` 完整输出、token、数据库 URL 或用户 openid 粘贴到日志和工单。
- 操作前记录当前 SHA；涉及配置、数据库、证书或回滚时先确认备份与恢复路径。
- 日志按 `requestId` 排查，不要求用户提供 access token 或 refresh token。

## 3. 运维 shell 准备

SSH 登录：

```bash
ssh -i ~/.ssh/jdcloud.pem root@117.72.174.2
```

进入 root shell 后加载当前发布状态，并定义仅在当前 shell 有效的 `prod_compose`：

```bash
set -a
. /opt/wx-private-media-upload/release.env
set +a

prod_compose() {
  docker compose \
    --project-name wx-private-media-upload-production \
    --env-file /etc/wx-private-media-upload/production.env \
    --file /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
    "$@"
}
```

`release.env` 只保存镜像名、SHA 和 release 目录；真实密钥仍从受限的 `production.env` 加载。不要执行 `prod_compose config` 并复制完整输出；配置校验只用：

```bash
prod_compose config --quiet
```

## 4. 巡检清单

### 4.1 每日

1. 公网 liveness 返回 200：

   ```bash
   curl --fail --show-error \
     https://api.rollinwave.store/health/live
   ```

2. 容器状态正常：

   ```bash
   prod_compose ps --all
   ```

   `postgres`、`api` 应为 healthy，`nginx` 应为 running，`migrate` 应已成功退出。

3. PostgreSQL 与 R2 联合 readiness 正常：

   ```bash
   prod_compose exec -T api \
     node --input-type=module --eval \
     "const r=await fetch('http://127.0.0.1:3000/health/ready',{headers:{'x-monitoring-token':process.env.MONITORING_TOKEN}}); process.stdout.write(await r.text()); if(!r.ok) process.exit(1)"
   ```

4. 最近一次 GitHub Actions 生产流程成功，部署 SHA 与 `release.env` 一致。
5. 每日数据库备份成功且校验文件存在，最近成功时间不超过 26 小时。
6. 磁盘、内存和 swap 无异常：

   ```bash
   df -h
   free -h
   swapon --show
   docker system df
   ```

7. 维护任务无失败，finalizer/abort backlog 没有持续增长。

### 4.2 每周

- 检查 Let’s Encrypt 剩余有效期、`certbot.timer` 和最近一次续期日志。
- 检查 runner 在线、系统补丁、Docker 日志磁盘占用和 GHCR 拉取能力。
- 抽查一个测试账号的小文件上传、进度、终态和上传记录。
- 检查 R2 仍未开放公共访问，7 天未完成 multipart 生命周期规则仍存在。
- 检查备份保留：至少 7 个日备和 4 个周备。

### 4.3 每月

- 在隔离环境执行 PostgreSQL 完整恢复演练，而不只是 `pg_restore --list`。
- 审核微信、R2、数据库、GitHub runner 和服务器访问权限。
- 审核证书、密钥和令牌到期时间，安排轮换窗口。
- 复核告警阈值、事故记录和容量趋势。
- 验证一个接近 200 MiB 的真实测试上传，但不要在生产 bucket 做破坏性故障注入。

## 5. 常用操作

### 5.1 查看状态和日志

```bash
prod_compose ps --all
prod_compose logs --since 30m --no-color api
prod_compose logs --since 30m --no-color nginx
prod_compose logs --since 30m --no-color postgres
prod_compose logs --no-color migrate
```

按 request ID 检索 API JSON 日志：

```bash
prod_compose logs --since 2h --no-color api \
  | grep -F '<request-id>'
```

日志中不得出现昵称、openid/unionid、文件名、object key、ETag、Authorization、cookie、数据库 URL 或任何 secret。

### 5.2 重启与重新创建服务

普通进程重启：

```bash
prod_compose restart api
```

修改 `production.env` 后，`restart` 不会重新加载容器环境，必须重新创建受影响服务：

```bash
prod_compose up --detach --no-deps --force-recreate api
prod_compose ps
```

如果改动数据库密码、TLS 或多个服务依赖，先制定变更顺序和回退方案，不要直接执行全栈 `down`。正常发布使用 GitHub Actions，而不是人工重建全部容器。

### 5.3 Nginx 配置和证书重载

Let’s Encrypt 续期成功后，Certbot 自动运行项目部署钩子。钩子会校验证书、使用发布锁、原子替换固定 TLS 文件、重建 Nginx、执行健康检查，并在失败时回滚。人工检查：

```bash
openssl x509 \
  -in /etc/wx-private-media-upload/tls/origin.crt \
  -noout -subject -issuer -dates -ext subjectAltName

prod_compose exec -T nginx nginx -t
systemctl status certbot.timer --no-pager
certbot certificates
```

需要手工部署现有 Certbot lineage 时：

```bash
RENEWED_LINEAGE=/etc/letsencrypt/live/api.rollinwave.store \
WX_UPLOAD_TLS_DOMAIN=api.rollinwave.store \
/etc/letsencrypt/renewal-hooks/deploy/50-wx-upload-nginx
```

再从公网检查 liveness 和证书链。不要只执行 `nginx -s reload`，因为 Docker 的文件 bind mount 需要重新创建 Nginx 容器才能可靠加载原子替换后的证书。

### 5.4 查看当前和历史版本

```bash
sed -n '1,20p' /opt/wx-private-media-upload/release.env
readlink -f /opt/wx-private-media-upload/current
find /opt/wx-private-media-upload/releases \
  -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
  | sort
```

`release.env` 不含生产 secret，可以用于版本审计。不要为了节省少量空间立即删除最近 release；至少保留当前版本和经过验证的上一个版本。

### 5.5 检查 runner

```bash
systemctl status \
  actions.runner.knighterrantsky-wxmp.wx-upload-production.service

journalctl \
  -u actions.runner.knighterrantsky-wxmp.wx-upload-production.service \
  --since '2 hours ago' \
  --no-pager
```

runner 必须以 `wxdeploy` 运行，且只能承接仓库受控的 `production` job。

## 6. 发布与回滚

### 6.1 正常发布

1. 代码经过 review 并合并到 `main`。
2. `verify` 通过后才允许 `publish`。
3. `publish` 把 API、PostgreSQL、Nginx 的同 SHA 镜像写入 GHCR，并生成 7 天保留的部署 artifact。
4. `deploy` 由生产 runner 执行，数据库迁移失败时 API 不会启动。
5. 发布后执行公网 liveness、内部 readiness、小文件上传和历史记录检查。

查看流程：

```bash
gh run list --repo knighterrantsky/wxmp --limit 10
```

### 6.2 回滚应用

先确认旧 SHA 的 release 目录与三类镜像仍存在，然后：

```bash
sudo -iu wxdeploy
. /opt/wx-private-media-upload/release.env
old_sha=<previous-40-character-commit-sha>

/opt/wx-private-media-upload/bin/deploy-release.sh \
  "$API_IMAGE" \
  "$old_sha" \
  "/opt/wx-private-media-upload/releases/$old_sha"
```

回滚只切换应用镜像和部署配置，不执行反向 migration。回滚后的 API 必须与当前 schema 兼容；否则应修复前向版本，而不是破坏性回退数据库。

### 6.3 发布失败

按顺序检查：

1. GitHub job 日志中失败的是 `verify`、`publish` 还是 `deploy`；
2. runner 是否 online，磁盘和网络是否正常；
3. GHCR 登录与三个不可变 tag 是否存在；
4. `prod_compose logs migrate`；
5. `prod_compose logs api` 和健康检查；
6. `/opt/wx-private-media-upload/current` 是否仍指向上一个成功 release。

部署脚本使用 `flock` 防止并发发布。遇到“Another production deployment is already running”时先检查是否确有 deploy 进程，不要删除锁文件绕过并发保护。

## 7. PostgreSQL 备份与恢复

### 7.1 备份

建议备份目录为 `/var/backups/wx-private-media-upload`，仅 root 可读：

```bash
install -d -o root -g root -m 0700 \
  /var/backups/wx-private-media-upload

umask 077
backup_file="/var/backups/wx-private-media-upload/wx-upload-$(date -u +%Y%m%dT%H%M%SZ).dump"

prod_compose exec -T postgres sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d wx_upload --format=custom --no-owner' \
  > "$backup_file"

prod_compose exec -T postgres pg_restore --list \
  < "$backup_file" > /dev/null
sha256sum "$backup_file" > "${backup_file}.sha256"
```

备份文件包含用户映射和业务数据，按敏感数据管理。至少保留 7 个日备、4 个周备和 3 个长期恢复点，并把副本保存到与该主机故障域隔离的位置。

### 7.2 恢复演练

恢复必须在隔离 PostgreSQL 实例中进行，禁止直接覆盖生产 `wx_upload`。最低步骤：

1. 校验 SHA-256 和 `pg_restore --list`；
2. 创建空的隔离 PostgreSQL 17 实例；
3. 恢复 schema 和数据；
4. 运行迁移到当前版本；
5. 核对关键表数量、用户映射、上传终态、审计记录和外键；
6. 使用隔离 API/R2 或只读验证程序完成登录与历史查询；
7. 记录恢复耗时、恢复点和校验结果；
8. 销毁演练环境和临时凭据。

`pg_restore --list` 只能证明归档可解析，不能替代完整恢复演练。

### 7.3 数据库故障禁令

- 不删除或重建生产 `postgres-data` volume，除非已经确认灾难恢复并获得明确批准。
- 不直接修改 `media_app.schema_migrations`。
- 不让 API 使用 `wx_migrate` 或 `wx_maintenance` 凭据。
- 修改角色密码时，先在数据库维护窗口更新角色，再原子更新对应 URL，并只重新创建使用该凭据的容器。

## 8. 维护任务

`maintenance` 为一次性 Compose profile，不随常驻服务启动。人工执行：

```bash
prod_compose \
  --profile maintenance \
  run --rm --no-deps maintenance
```

该任务清理过期幂等账本、终态分片明细、过期或撤销会话及审计保留数据，不删除已经完成的 R2 对象。

建议使用 systemd timer 每日执行。服务示例：

```ini
# /etc/systemd/system/wx-upload-maintenance.service
[Unit]
Description=WeChat upload retention maintenance
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=wxdeploy
Group=wxdeploy
EnvironmentFile=/opt/wx-private-media-upload/release.env
ExecStart=/usr/bin/docker compose --project-name wx-private-media-upload-production --env-file /etc/wx-private-media-upload/production.env --file /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml --profile maintenance run --rm --no-deps maintenance
```

定时器示例：

```ini
# /etc/systemd/system/wx-upload-maintenance.timer
[Unit]
Description=Run WeChat upload retention maintenance daily

[Timer]
OnCalendar=*-*-* 03:20:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
```

安装后检查任务退出码并接入告警：

```bash
systemctl daemon-reload
systemctl enable --now wx-upload-maintenance.timer
systemctl list-timers wx-upload-maintenance.timer
journalctl -u wx-upload-maintenance.service --since today --no-pager
```

## 9. 故障处理

### 9.1 HTTPS 证书或握手失败

当前 DNS 由京东云直接解析到服务器，不经过 Cloudflare。浏览器、微信或 curl 的证书错误通常表示 Let’s Encrypt 证书未部署、已过期、域名不匹配或 Nginx 仍挂载旧文件。

按顺序检查：

```bash
curl --show-error --include \
  https://api.rollinwave.store/health/live

openssl s_client \
  -connect 117.72.174.2:443 \
  -servername api.rollinwave.store \
  -showcerts </dev/null
```

然后确认：

1. Nginx 容器运行且监听宿主机 443；
2. 当前证书 issuer 为 Let’s Encrypt，覆盖 `api.rollinwave.store` 且未过期；
3. `certbot.timer` 为 enabled/active，`certbot certificates` 显示正确 lineage；
4. 京东云 DNS 的 `api` A 记录指向 `117.72.174.2`；
5. 京东云轻量主机已经关联根域名 `rollinwave.store`；
6. 管局备案最终通过；
7. 主机防火墙和京东云防火墙允许 80、443。

如果续期成功但服务仍返回旧证书，手工运行续期部署钩子；钩子失败会恢复旧证书，并在 stderr 和 systemd 日志中留下原因。

### 9.2 Nginx 502/504

先检查：

```bash
prod_compose ps
prod_compose logs --since 30m --no-color nginx
prod_compose logs --since 30m --no-color api
```

- 502 通常表示 Nginx 无法连接 API、API 重启或上游提前关闭。
- 504 通常表示分片上传超过代理/上游超时、API 阻塞或 R2 延迟异常。
- 分片路由允许 16 MiB，代理超时为 210 秒；普通路由 body 上限为 64 KiB。

不要通过全局无限增大超时掩盖 R2、带宽或应用问题。

### 9.3 liveness 正常、readiness 503

这表示 API 进程存活，但 PostgreSQL 或 R2 的 2 秒联合探测失败。

```bash
prod_compose logs --since 30m --no-color api
prod_compose ps postgres
```

结合指标区分：

- PostgreSQL：连接错误、连接池错误、磁盘满、数据库重启；
- R2：endpoint/DNS/凭据、bucket 权限、网络超时、上游错误；
- 两者都正常但仍超时：检查主机网络、CPU、内存和事件循环阻塞。

readiness 需要监控令牌且只允许私网或容器网络访问，公网 403/401 不代表依赖故障。

### 9.4 migration 失败

```bash
prod_compose logs --no-color migrate
```

确认 `MIGRATION_DATABASE_URL` 使用 `wx_migrate`，数据库可连接，迁移 SQL 与当前 schema 兼容。禁止跳过迁移强行启动 API，也不要手工把失败迁移标记为成功。

### 9.5 R2 上传失败

检查 API 日志中的受控 R2 operation/outcome、readiness 和 Cloudflare R2 状态。确认：

- endpoint 是账户专属 HTTPS 根地址；
- bucket 名正确且保持私有；
- S3 Access Key/Secret 未撤销并具有目标 bucket 的读写权限；
- 服务器时钟正确；
- 没有把 Cloudflare API token value 误填为 S3 secret；
- 轮换凭据时新旧凭据没有提前撤销。

不要在客户端下发临时 R2 凭据，也不要临时开放 bucket 验证问题。

### 9.6 上传长时间停在 finalizing

1. 查看 `wx_upload_finalizer_backlog`、retry 和 reconciliation 指标；
2. 以 requestId、内部 uploadId 检索 API 日志；
3. 检查 R2 complete/head/listParts 操作；
4. 保持后台对账运行，等待确定存储事实；
5. 只有服务端明确返回可修复 parts 时，客户端才创建新的 complete 周期。

禁止直接把数据库状态改为 `uploaded`，也禁止创建第二个未知 multipart 覆盖原状态。

### 9.7 磁盘空间不足

```bash
df -h
docker system df
journalctl --disk-usage
du -sh /opt/wx-private-media-upload/releases/*
du -sh /var/lib/docker
```

先确认增长来源。Docker 已配置单文件 10 MiB、最多 3 个文件的 JSON 日志轮转。清理镜像或 release 前记录当前和回滚 SHA；禁止使用 `docker system prune --volumes`，因为 volume 中包含 PostgreSQL 数据。

### 9.8 runner offline

```bash
systemctl status \
  actions.runner.knighterrantsky-wxmp.wx-upload-production.service

journalctl \
  -u actions.runner.knighterrantsky-wxmp.wx-upload-production.service \
  --since '1 hour ago' \
  --no-pager
```

确认服务器能访问 GitHub 与 GHCR、磁盘有空间、服务用户为 `wxdeploy`。runner 重新注册需要 GitHub 生成的短期 token；不要把注册 token 写入脚本或仓库。

## 10. 证书与密钥轮换

### 10.1 建议顺序

1. 创建新凭据或证书，但暂不撤销旧值；
2. 安装新值并校验格式、权限和对应公钥；
3. 只重新创建受影响容器或重载 Nginx；
4. 验证 liveness、readiness、真实登录、小文件上传和历史记录；
5. 撤销旧值；
6. 记录时间、执行人、影响和新凭据标识，绝不记录 secret 本身。

### 10.2 各类影响

| 凭据 | 影响与注意事项 |
| --- | --- |
| R2 S3 凭据 | 更新 API 后验证读写，再撤销旧凭据；bucket 始终私有 |
| 微信 AppSecret | 微信平台生成/重置后立即更新 API；验证真实 `code2Session` |
| JWT Ed25519 | 当前只支持一套验证公钥，轮换会要求用户重新登录 |
| 游标签名 key | 旧上传历史游标失效，数据不丢失 |
| 监控令牌 | 同步更新受控监控抓取配置，再重新创建 API |
| 数据库密码 | 先修改数据库角色，再更新对应 URL；三个应用角色分别轮换 |
| TLS 私钥 | 由 Certbot 续期；部署钩子原子替换固定文件并重建 Nginx |

已经在聊天、终端回显、日志或工单中出现过的私钥、AppSecret、R2 secret 应视为暴露并安排轮换，即使它们没有提交到 Git。

## 11. 监控与事件响应

监控入口：

| 路径 | 语义 | 访问方式 |
| --- | --- | --- |
| `/health/live` | API 进程存活 | 公网 HTTPS |
| `/health/ready` | PostgreSQL 与 R2 联合探测 | 私网/容器网络 + 监控令牌 |
| `/internal/metrics` | Prometheus 指标 | 只允许容器网络直连 API + 监控令牌 |

最低告警：

- liveness 或 readiness 连续 3 次失败；
- 登录或分片 5 分钟错误率超过 5%；
- finalizer backlog 持续 15 分钟；
- 完成超时计数增加；
- 数据库备份失败或最近成功超过 26 小时；
- 磁盘使用率达到 80% 预警、90% 紧急；
- TLS 剩余有效期少于 30 天。

事件处理顺序：

1. 记录开始时间、环境、当前 SHA 和告警快照；
2. 检查公网 liveness、内部 readiness 和容器状态；
3. 以 requestId 查询结构化日志；
4. 定位微信、PostgreSQL、R2、Nginx、主机或发布链路；
5. 优先采取可回退、最小影响的恢复动作；
6. 恢复后验证真实登录、小文件上传、上传记录、backlog 和备份；
7. 记录根因、修复、影响范围和后续行动。

Prometheus 指标和建议 PromQL 见[监控与故障处理手册](monitoring.md)。

## 12. 变更记录模板

```text
变更/事件编号：
开始时间：
结束时间：
执行人：
环境：production
变更前 SHA：
变更后 SHA：
影响范围：
备份位置与校验：
执行步骤：
验证结果：
回滚条件与结果：
根因：
后续行动：
```

记录中只能使用内部 userId、uploadId、mediaId 和 requestId；不要记录昵称、openid、文件名、object key、token、密码或完整数据库 URL。

## 13. 相关文档

- [生产部署文档](deployment.md)
- [GitHub Actions、GHCR 与生产自动部署](github-cicd.md)
- [生产密钥与部署手册](production-secrets.md)
- [监控与故障处理手册](monitoring.md)
- [真机手工验收清单](manual-acceptance.md)
- [API 文档](../api/media-upload-api.md)
- [数据库设计](../database/media-upload-database.md)
