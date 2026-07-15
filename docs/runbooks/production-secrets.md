# 生产密钥与部署手册

## 1. 部署边界

生产 `deploy/docker-compose.prod.yml` 只运行：

- `nginx`：443 TLS 入口；
- `api`：非 root 用户运行已编译 JavaScript；
- `postgres`：仅容器网络可达；
- `migrate`：一次性迁移与授权任务；
- `maintenance`：只在显式启用 profile 时执行一次保留清理。

Cloudflare R2 位于容器集群之外并保持私有。生产配置不包含 MinIO，也把微信认证模式固定为 `real`。

## 2. 密钥清单

以 `.env.example` 为清单填写服务器本地 `/etc/wx-private-media-upload/production.env`，权限设置为 root 可写、部署账号组只读，并确保该文件不进入 Git、GHCR、备份日志或工单正文：

```bash
sudo chown root:wxdeploy /etc/wx-private-media-upload/production.env
sudo chmod 640 /etc/wx-private-media-upload/production.env
```

所有 `<required-...>` 标记都必须替换。生产配置加载器还会拒绝常见占位词、本地 R2 endpoint、错误的 Ed25519 密钥对、过短密钥和微信 stub。

### 2.1 微信凭据

- `WECHAT_APP_ID`：当前小程序 AppID。
- `WECHAT_APP_SECRET`：对应 AppSecret，只进入 API 容器。
- `WECHAT_AUTH_MODE` 在生产 Compose 中固定为 `real`。
- `WECHAT_CODE2SESSION_ENDPOINT` 固定为微信官方 HTTPS 地址，不允许生产环境覆盖到其他主机。

AppSecret 不得写入小程序配置、构建产物、Nginx 配置或日志。

### 2.2 JWT Ed25519 密钥

生成一组匹配的 PKCS#8 私钥与 SPKI 公钥：

```bash
umask 077
openssl genpkey -algorithm ED25519 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
```

将两个 PEM 完整内容分别写入 `JWT_PRIVATE_KEY` 和 `JWT_PUBLIC_KEY`。Compose `.env` 中可使用单引号包围多行值。私钥只进入 API 容器；公钥不能代替私钥，二者不匹配时 API 会拒绝启动。

密钥轮换需兼顾尚未过期的 access token。本版只配置一个验证公钥，因此轮换窗口应先安排用户重新登录，再同步替换密钥对并重启 API。

### 2.3 游标签名与监控令牌

- `CURSOR_SIGNING_KEY`：至少 32 个随机字节，使用无填充 base64url；更换后旧历史游标失效，但上传数据不受影响。
- `MONITORING_TOKEN`：至少 32 个字符，与用户 JWT、R2 密钥和数据库密码相互独立。

示例生成命令：

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '='
openssl rand -hex 32
```

### 2.4 幂等 Key 说明

当前实现没有服务端 `IDEMPOTENCY_SIGNING_KEY`，也不需要新增此类环境变量。幂等由小程序为每次业务周期生成 UUIDv7 `Idempotency-Key`，API 把请求哈希和稳定结果写入 PostgreSQL 账本。实施计划中“幂等 secret”这一项对当前实现不适用；添加一个 API 不读取的伪密钥不能提升安全性。

客户端 Key 不是长期凭据，不能拿来替代 JWT、游标签名或监控令牌。

### 2.5 PostgreSQL 四类密码与三条角色连接

首次初始化空 volume 时，PostgreSQL 容器读取四个密码：

- `POSTGRES_ADMIN_PASSWORD`：数据库管理账号；
- `POSTGRES_MIGRATION_PASSWORD`：`wx_migrate`；
- `POSTGRES_RUNTIME_PASSWORD`：`wx_runtime`；
- `POSTGRES_MAINTENANCE_PASSWORD`：`wx_maintenance`。

三条角色 URL 中的密码必须与对应初始化密码一致；URL 保留字符必须百分号编码：

```text
DATABASE_URL=postgresql://wx_runtime:<encoded>@postgres:5432/wx_upload
MIGRATION_DATABASE_URL=postgresql://wx_migrate:<encoded>@postgres:5432/wx_upload
MAINTENANCE_DATABASE_URL=postgresql://wx_maintenance:<encoded>@postgres:5432/wx_upload
```

容器环境严格隔离：

| 进程          | 唯一业务数据库连接         |
| ------------- | -------------------------- |
| `api`         | `DATABASE_URL`             |
| `migrate`     | `MIGRATION_DATABASE_URL`   |
| `maintenance` | `MAINTENANCE_DATABASE_URL` |

绝对不要把迁移或维护 URL 注入 `api`，也不要让维护任务使用运行时连接。PostgreSQL 本身在空卷初始化阶段必然接收三种角色密码，用于创建登录角色；这不改变三个应用进程的凭据隔离。

初始化 SQL 仅在空 volume 第一次启动时执行。修改 `.env` 不会自动修改已有角色密码；应在维护窗口通过 PostgreSQL 管理连接执行角色密码轮换，再原子更新对应 URL，并逐个重建相关容器。

### 2.6 Cloudflare R2

- `R2_ENDPOINT` 必须是账户专属的 `https://<account-id>.r2.cloudflarestorage.com` 根地址。
- `R2_BUCKET` 使用生产专用 bucket；开发、CI、smoke test 使用不同 bucket。
- `R2_ACCESS_KEY_ID` 与 `R2_SECRET_ACCESS_KEY` 使用仅限该 bucket 的最小范围 S3 凭据，并只进入 API 容器。
- `R2_FORCE_PATH_STYLE` 在生产 Compose 中固定为 `false`。

在 Cloudflare 控制台确认 bucket 没有对外对象交付域名或匿名访问策略。应用没有对象下载接口，客户端也不会收到 object key 或签名地址。

必须为生产 bucket 配置一条生命周期规则：

- 仅终止创建超过 7 天仍未完成的 multipart upload；
- 不设置完成对象的自动删除或到期规则；
- 上线前创建一个测试 multipart，确认规则命中范围和天数，再清理该测试上传。

R2 生命周期是应用 24 小时会话清理与后台对账之外的最终兜底，不能替代应用任务。

### 2.7 TLS 文件

`TLS_CERTIFICATE_FILE` 和 `TLS_PRIVATE_KEY_FILE` 必须是宿主机绝对路径，Compose 将它们只读挂载到 Nginx。证书需要覆盖微信后台登记的完整 API 域名。续签由宿主机证书工具负责；续签后校验证书，再平滑重载 Nginx。

## 3. 上线步骤

### 3.1 外部准备

1. 将 API 域名 DNS 指向服务器。
2. 在微信小程序后台把同一 HTTPS 域名加入 request 与 uploadFile 合法域名。
3. 在微信公众平台《小程序用户隐私保护指引》中如实声明昵称收集及用途；未声明时 `<input type="nickname">` 的微信昵称候选能力不会生效。
4. 防火墙仅开放所需管理来源、证书入口和 443；不要开放 PostgreSQL 5432。
5. 完成 R2 私有状态与 7 天未完成 multipart 生命周期检查。
6. 建立 PostgreSQL 每日备份：7 个日备、4 个周备和 3 个长期恢复点；每月至少在隔离环境恢复一次。

### 3.2 配置预检

自动部署脚本会注入私有 GHCR 镜像名与完整 commit SHA。手工预检时也必须显式提供这两个非密钥值。`docker compose config` 会展开其他环境变量，输出可能包含密钥，因此只检查退出码，不保存或粘贴完整输出：

```bash
API_IMAGE=ghcr.io/<owner>/<repository>-api \
IMAGE_TAG=<40-character-commit-sha> \
docker compose --env-file /etc/wx-private-media-upload/production.env \
  -f /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
  config --quiet
```

确认最终服务集合没有本地对象存储或微信模拟服务，并检查数据库变量分配：

```bash
API_IMAGE=ghcr.io/<owner>/<repository>-api \
IMAGE_TAG=<40-character-commit-sha> \
docker compose --env-file /etc/wx-private-media-upload/production.env \
  -f /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
  config --services
```

### 3.3 发布与启动

正常发布由 GitHub Actions 完成：完整 CI 验证成功后，GitHub 托管 runner 构建镜像并推送 private GHCR；只有显式开启生产变量后，服务器 self-hosted runner 才会按不可变 SHA 拉取和启动。首次配置与 runner 注册见 [GitHub Actions、GHCR 与生产自动部署](github-cicd.md)。

```bash
./deploy/scripts/deploy-release.sh \
  ghcr.io/<owner>/<repository>-api \
  <40-character-commit-sha> \
  "$PWD"
```

这个手工命令只用于首次联调或故障恢复，执行账号必须已登录 GHCR。服务器不会从源码构建。启动依赖顺序为 PostgreSQL 健康、`migrate` 成功退出、API 健康、Nginx 启动。迁移失败时 API 不会启动；先查看迁移日志并修复，不能跳过：

```bash
docker compose \
  --project-name wx-private-media-upload-production \
  --env-file /etc/wx-private-media-upload/production.env \
  -f /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
  logs migrate
```

从服务器内网携带独立监控令牌检查 readiness；公网只用 liveness：

```bash
curl --fail https://api.example.com/health/live
read -rsp 'Monitoring token: ' MONITORING_TOKEN && printf '\n'
curl --fail \
  -H "X-Monitoring-Token: ${MONITORING_TOKEN}" \
  https://api.example.com/health/ready
unset MONITORING_TOKEN
```

Nginx 把普通请求限制为 64 KiB；仅分片路由允许 16 MiB、关闭请求缓冲并使用 210 秒上游超时。

## 4. 定时执行保留清理

`maintenance` 是一次性 profile，不随常驻服务自动运行。使用宿主机 systemd timer 或同等计划任务每天执行一次：

```bash
set -a
. /opt/wx-private-media-upload/release.env
set +a
docker compose --env-file /etc/wx-private-media-upload/production.env \
  -f /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
  --profile maintenance \
  run --rm --no-deps maintenance
```

计划任务必须检查退出码并告警。该容器只接收 `MAINTENANCE_DATABASE_URL`，不得改用迁移或 API 连接。在线清理范围为过期幂等账本、终态分片明细、过期/撤销会话和审计保留数据；完整 R2 对象不由该任务删除。

## 5. 发布与回滚原则

1. 先备份 PostgreSQL并验证备份可读取。
2. 先执行向后兼容的 expand migration，再更新 API，最后发布兼容的小程序版本。
3. 破坏性 schema 变更留到旧 API 与旧小程序退出后。
4. API 镜像按完整 commit SHA 发布；按旧 SHA 回滚应用时不要反向执行已写入数据的 migration。
5. 回滚后重新验证 `/health/live`、私有 `/health/ready`、一次小文件上传、历史状态与监控指标。
