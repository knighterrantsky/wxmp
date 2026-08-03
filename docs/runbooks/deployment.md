# 生产部署文档

本文档是本项目从空服务器到生产发布的统一入口。命令和目录以当前仓库实现为准；密钥、令牌和密码只允许保存在服务器受限文件或对应云平台中，不得写入 Git、镜像、日志或工单。

## 1. 生产环境基线

| 项目 | 当前值 |
| --- | --- |
| GitHub 仓库 | `knighterrantsky/wxmp` |
| 默认分支 | `main` |
| API 域名 | `api.rollinwave.store` |
| 源站 IP | `117.72.174.2` |
| 操作系统 | Ubuntu 24.04 x64 |
| 容器编排 | Docker Compose |
| Compose project | `wx-private-media-upload-production` |
| 镜像仓库 | `ghcr.io/knighterrantsky/wxmp-api` |
| 服务器上传落盘 | Docker named volume `upload-spool` |
| 内部对象存储 | Cloudflare R2 私有 bucket |
| 数据库 | PostgreSQL 17 |
| 服务器部署根目录 | `/opt/wx-private-media-upload` |
| 生产配置 | `/etc/wx-private-media-upload/production.env` |
| TLS 目录 | `/etc/wx-private-media-upload/tls` |
| 部署账号 | `wxdeploy` |

当前生产部署运行 Nginx、API、PostgreSQL、持久化 `upload-spool` 卷、一次性 `spool-init`/数据库迁移任务，以及按计划运行的维护任务。微信小程序由微信开发者工具或后续微信 CI 发布，不部署在该服务器上。

## 2. 交付架构

```text
微信小程序
    |
    | HTTPS /v1
    v
京东云 DNS
    |
    v
京东云轻量主机 :443
    |
    v
Nginx -> Fastify API -> upload-spool（持久化本地分片）
                    |             |
                    v             | 服务端内部队列
               PostgreSQL        v
                          Cloudflare R2（私有）

main push
    |
    v
GitHub Actions：verify -> publish -> deploy
                         |          |
                         v          v
                        GHCR   self-hosted runner
```

安全边界：

- 小程序只保存公开 API origin，不包含 AppSecret、R2 凭据、JWT 私钥或数据库密码。
- 小程序只上传到 Fastify API；数据完整落入 `upload-spool` 并在 PostgreSQL 中形成可恢复队列任务后，即返回用户级“已上传”。
- R2 不开启公开访问，API 不返回 object key、multipart upload ID、存储凭据或下载地址。
- PostgreSQL 不映射宿主机端口；API 3000 端口也不对公网开放。
- 生产镜像和部署目录使用完整 40 位 Git commit SHA 标识，禁止用可变 `latest` 标签部署。
- 服务器从 GitHub Actions artifact 获取已验证的 `deploy` 目录，不在生产机检出或构建源码。

## 3. 发布前外部配置

### 3.1 域名、京东云和 Let’s Encrypt

1. 在京东云轻量主机控制台把根域名 `rollinwave.store` 关联到当前实例，并确认管局备案最终通过。
2. 在京东云 DNS 创建 `api.rollinwave.store` 到 `117.72.174.2` 的 A 记录。
3. 京东云轻量主机防火墙开放 TCP 80、443；80 只供 Certbot standalone 的 HTTP-01 验证使用。
4. 服务器使用 Let’s Encrypt 公信证书，证书必须覆盖 `api.rollinwave.store`。
5. 域名关联、DNS、80/443 和证书都正常后，`https://api.rollinwave.store/health/live` 应返回 200。

当前 DNS 不经过 Cloudflare；Cloudflare 只继续提供私有 R2 对象存储。

### 3.2 微信公众平台

在小程序后台完成：

- 把 `https://api.rollinwave.store` 加入 `request` 合法域名；
- 把同一域名加入 `uploadFile` 合法域名；
- 确认域名证书链和 443 端口可由微信访问；
- 在《小程序用户隐私保护指引》中声明微信昵称的收集目的和使用方式；
- 生产验收使用基础库 2.32.3 或更高版本。

### 3.3 Cloudflare R2

1. 创建生产专用 bucket，保持公开访问和自定义公开域名关闭。
2. 创建仅限该 bucket、仅包含应用所需对象读写能力的生产 S3 凭据。
3. 应用使用生成的 `Access Key ID` 和 `Secret Access Key`；Cloudflare 控制台显示的 API token value 不写入应用配置。
4. 配置生命周期规则：只终止创建超过 7 天仍未完成的 multipart upload，不删除已完成对象。
5. 开发、CI 和生产使用不同 bucket 与凭据。

## 4. 一次性服务器初始化

从开发机连接服务器：

```bash
ssh -i ~/.ssh/jdcloud.pem root@117.72.174.2
```

首次初始化时，在仓库根目录执行：

```bash
scp -i ~/.ssh/jdcloud.pem \
  deploy/scripts/bootstrap-ubuntu.sh \
  root@117.72.174.2:/root/bootstrap-ubuntu.sh

ssh -i ~/.ssh/jdcloud.pem root@117.72.174.2 \
  'chmod 700 /root/bootstrap-ubuntu.sh && /root/bootstrap-ubuntu.sh'
```

脚本会安装 Docker、Buildx 和 Compose，创建 `wxdeploy`，创建发布与配置目录，设置 Docker 日志轮转，并在需要时创建 2 GiB swap。

初始化后核对：

```bash
docker version
docker compose version
id wxdeploy
stat -c '%U:%G %a %n' /etc/wx-private-media-upload/production.env
swapon --show
```

生产配置文件预期权限为 `root:wxdeploy 640`。`wxdeploy` 属于 `docker` 组，等价于具有较高主机权限，因此生产 runner 不能执行 pull request、fork 或任意未审核工作流。

## 5. Let’s Encrypt TLS 与自动续期

安装 Certbot，系统包会启用每天两次的续期检查：

```bash
apt-get update
apt-get install --yes certbot
systemctl enable --now certbot.timer
```

Nginx 只占用 443，因此 Certbot 可在申请和续期时临时监听 80：

```bash
certbot certonly \
  --standalone \
  --preferred-challenges http \
  --domain api.rollinwave.store \
  --email <certificate-notification-email> \
  --agree-tos \
  --no-eff-email
```

把仓库中的受控部署钩子安装到 Certbot 标准目录：

```bash
install -d -o root -g root -m 0755 \
  /etc/letsencrypt/renewal-hooks/deploy

install -o root -g root -m 0750 \
  /opt/wx-private-media-upload/current/deploy/scripts/deploy-renewed-certificate.sh \
  /etc/letsencrypt/renewal-hooks/deploy/50-wx-upload-nginx
```

钩子会校验证书域名、剩余有效期和公私钥，使用生产发布锁，原子更新固定 TLS 文件，重建 Nginx，并在失败时恢复旧证书。首次签发后可显式部署：

```bash
RENEWED_LINEAGE=/etc/letsencrypt/live/api.rollinwave.store \
WX_UPLOAD_TLS_DOMAIN=api.rollinwave.store \
/etc/letsencrypt/renewal-hooks/deploy/50-wx-upload-nginx
```

固定 TLS 文件仍为：

```text
/etc/wx-private-media-upload/tls/origin.crt
/etc/wx-private-media-upload/tls/origin.key
```

检查证书而不输出私钥：

```bash
openssl x509 \
  -in /etc/wx-private-media-upload/tls/origin.crt \
  -noout -subject -issuer -dates -ext subjectAltName

certbot certificates
systemctl list-timers certbot.timer
certbot renew --dry-run --no-random-sleep-on-renew
```

## 6. 生产环境变量

以仓库根目录的 `.env.example` 为清单，把真实值写入：

```bash
sudoedit /etc/wx-private-media-upload/production.env
chown root:wxdeploy /etc/wx-private-media-upload/production.env
chmod 640 /etc/wx-private-media-upload/production.env
```

必须配置的类别：

| 类别 | 变量 |
| --- | --- |
| PostgreSQL 初始化 | `POSTGRES_ADMIN_PASSWORD`、`POSTGRES_MIGRATION_PASSWORD`、`POSTGRES_RUNTIME_PASSWORD`、`POSTGRES_MAINTENANCE_PASSWORD` |
| PostgreSQL 连接 | `DATABASE_URL`、`MIGRATION_DATABASE_URL`、`MAINTENANCE_DATABASE_URL` |
| 微信 | `WECHAT_APP_ID`、`WECHAT_APP_SECRET` |
| JWT | `JWT_PRIVATE_KEY`、`JWT_PUBLIC_KEY` |
| API 安全 | `CURSOR_SIGNING_KEY`、`MONITORING_TOKEN` |
| R2 | `R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` |
| 持久化上传目录 | `UPLOAD_SPOOL_DIR`（Compose 固定为 `/var/lib/wx-upload/spool`） |
| TLS | `TLS_CERTIFICATE_FILE`、`TLS_PRIVATE_KEY_FILE`、`HTTPS_PORT` |

数据库 URL 中的密码必须与对应角色密码一致，保留字符需要百分号编码。生产 Compose 固定真实微信认证和 R2 virtual-hosted 风格，不需要在服务器配置微信 stub 或 MinIO。

JWT 使用 Ed25519 密钥对：

```bash
umask 077
openssl genpkey -algorithm ED25519 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
```

随机值示例：

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '='
openssl rand -hex 32
```

自动部署时，`API_IMAGE`、`POSTGRES_IMAGE`、`NGINX_IMAGE` 和 `IMAGE_TAG` 由工作流注入，不需要把某次 SHA 固定写入生产配置。不要执行会把完整 Compose 配置展开到终端或日志的命令；预检只使用 `config --quiet`。

## 7. GitHub Actions 与生产 runner

### 7.1 仓库设置

1. `Settings -> Actions -> General` 允许工作流读取源码并写入 packages。
2. 建议保护 `main`，要求 `CI / verify` 通过后才能合并。
3. 在 `Settings -> Secrets and variables -> Actions -> Variables` 设置：

```text
ENABLE_PRODUCTION_DEPLOY=true
```

生产密钥不保存到 GitHub Secrets；工作流只使用仓库自带的短期 `GITHUB_TOKEN` 推送和拉取 GHCR。

### 7.2 runner

生产 runner 运行在 `wxdeploy` 用户下，标签必须包含：

```text
self-hosted, linux, x64, production
```

当前服务名：

```text
actions.runner.knighterrantsky-wxmp.wx-upload-production.service
```

检查状态：

```bash
systemctl status \
  actions.runner.knighterrantsky-wxmp.wx-upload-production.service
```

runner 注册和重建步骤见 [GitHub Actions、GHCR 与生产自动部署](github-cicd.md)。

## 8. 后端自动发布

正常发布只需把通过审查的代码合并或推送到 `main`：

```bash
git push origin main
```

流水线依次执行：

1. `verify`：格式、Lint、类型、单元/集成测试、跨端 E2E 和构建；
2. `publish`：构建 API 镜像，把固定版本 PostgreSQL 与 Nginx 同步到同一 GHCR package，并上传部署 artifact；
3. `deploy`：生产 runner 下载 artifact，按完整 commit SHA 拉取镜像、运行迁移并启动 Compose。

生产标签格式：

```text
ghcr.io/knighterrantsky/wxmp-api:<commit-sha>
ghcr.io/knighterrantsky/wxmp-api:postgres-<commit-sha>
ghcr.io/knighterrantsky/wxmp-api:nginx-<commit-sha>
```

发布脚本只有在 PostgreSQL 健康、迁移成功、API 健康且 Nginx 启动后，才更新：

```text
/opt/wx-private-media-upload/current
/opt/wx-private-media-upload/release.env
```

## 9. 小程序构建与发布

小程序构建不会由后端 Docker 流水线完成。在开发机执行：

```bash
cp \
  apps/miniprogram/project.private.config.json.example \
  apps/miniprogram/project.private.config.json

NODE_ENV=production \
PUBLIC_API_BASE_URL=https://api.rollinwave.store \
pnpm --filter @wx-upload/miniprogram generate:config
```

把真实 AppID 写入 `project.private.config.json`，然后在微信开发者工具中导入 `apps/miniprogram`。`project.private.config.json` 和 `config.generated.ts` 已被 Git 忽略；每次生产构建都要重新生成 API 配置。

发布前完成：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

随后在微信开发者工具上传版本，在公众平台提交审核并发布。真机用例见[真机手工验收清单](manual-acceptance.md)。

## 10. 发布后验证

### 10.1 GitHub

确认本次 `verify`、`publish` 和 `deploy` 全部成功，且 deploy 使用的 SHA 与 `main` HEAD 一致：

```bash
gh run list --repo knighterrantsky/wxmp --limit 5
git rev-parse origin/main
```

### 10.2 服务器

在服务器 root shell 中加载当前非敏感发布状态，并检查容器：

```bash
set -a
. /opt/wx-private-media-upload/release.env
set +a

docker compose \
  --project-name wx-private-media-upload-production \
  --env-file /etc/wx-private-media-upload/production.env \
  --file /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
  ps --all
```

预期：`postgres` 和 `api` 为 healthy，`nginx` 为 running，`migrate` 和 `spool-init` 成功退出。`spool-init` 只负责把命名卷目录设为 API 运行 UID/GID `1000:1000`、权限 `0700`。

检查内部 readiness；令牌直接从 API 容器环境读取，不展开到宿主机命令历史：

```bash
docker compose \
  --project-name wx-private-media-upload-production \
  --env-file /etc/wx-private-media-upload/production.env \
  --file /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
  exec -T api \
  node --input-type=module --eval \
  "const r=await fetch('http://127.0.0.1:3000/health/ready',{headers:{'x-monitoring-token':process.env.MONITORING_TOKEN}}); process.stdout.write(await r.text()); if(!r.ok) process.exit(1)"
```

返回 `{"status":"ready"}` 表示 PostgreSQL 与 `upload-spool` 持久化目录均可用。R2 状态不阻断服务器接收新文件，需通过 finalizer backlog 与 R2 错误指标另行验证。

最后从公网检查：

```bash
curl --fail --show-error \
  https://api.rollinwave.store/health/live
```

## 11. 回滚原则

已成功 release 保存在：

```text
/opt/wx-private-media-upload/releases/<commit-sha>
```

应用回滚使用旧 SHA 和旧 release 目录，不回退数据库 migration：

```bash
sudo -iu wxdeploy
. /opt/wx-private-media-upload/release.env
old_sha=<previous-40-character-commit-sha>

/opt/wx-private-media-upload/bin/deploy-release.sh \
  "$API_IMAGE" \
  "$old_sha" \
  "/opt/wx-private-media-upload/releases/$old_sha"
```

执行前，`wxdeploy` 必须已经通过短期凭据或只读 package 凭据登录 GHCR。回滚后重新执行服务器 readiness、公网 liveness、小文件上传和上传记录验证。

数据库 schema 必须使用 expand/contract 兼容策略。禁止为了回滚 API 而删除 PostgreSQL volume、手工反向修改迁移表或直接改写上传终态。

## 12. 上线检查清单

- [ ] 京东云已关联 `rollinwave.store`，管局备案最终通过
- [ ] 京东云 DNS 的 `api` A 记录指向正确 IP，80/443 已开放
- [ ] Let’s Encrypt 证书覆盖 `api.rollinwave.store`，自动续期演练成功
- [ ] R2 bucket 私有，凭据为 bucket 最小权限，7 天未完成 multipart 规则存在
- [ ] 微信 request/uploadFile 合法域名和隐私指引已配置
- [ ] `production.env` 无占位值且权限为 `root:wxdeploy 640`
- [ ] self-hosted runner 在线且只带生产受控标签
- [ ] GitHub `ENABLE_PRODUCTION_DEPLOY=true`
- [ ] CI 的 verify、publish、deploy 全部成功
- [ ] PostgreSQL/API healthy，Nginx running，内部 readiness 为 ready
- [ ] 公网 liveness 返回 200
- [ ] 真机完成登录、昵称授权、二次确认、进度、200 MiB 边界和上传记录验收
- [ ] PostgreSQL 备份与恢复演练已建立

## 13. 相关文档

- [GitHub Actions、GHCR 与生产自动部署](github-cicd.md)
- [生产密钥与部署手册](production-secrets.md)
- [运维文档](operations.md)
- [监控与故障处理手册](monitoring.md)
- [真机手工验收清单](manual-acceptance.md)
- [API 文档](../api/media-upload-api.md)
- [数据库设计](../database/media-upload-database.md)
