# 本地开发手册

## 1. 准备环境

需要 Node.js 24、Docker Compose、微信开发者工具、微信基础库 2.32.3 或更高版本，以及仓库声明的 pnpm 11。首次进入仓库执行：

```bash
corepack enable
pnpm --version
pnpm install --frozen-lockfile
```

`pnpm --version` 应显示 `11.x`。不要用 npm 或非锁定安装改写 `pnpm-lock.yaml`。

## 2. 启动 PostgreSQL 17 与私有 MinIO

```bash
docker compose -f deploy/docker-compose.yml up --detach --wait postgres minio
docker compose -f deploy/docker-compose.yml run --rm minio-init
```

本地端口仅绑定到 `127.0.0.1`：

- PostgreSQL：`55432`
- MinIO S3 API：`59000`
- MinIO 控制台：`59001`

默认 bucket 为 `wx-private-media`，`minio-init` 会创建它并明确关闭匿名访问。

如果修改了本地数据库角色密码，已有 volume 不会重新执行初始化脚本。仅在确认可以删除本地数据后执行：

```bash
docker compose -f deploy/docker-compose.yml down --volumes
```

然后重新启动依赖。

## 3. 执行迁移与权限收敛

迁移进程只接收迁移连接；角色名用于迁移完成后的最小权限授权：

```bash
export MIGRATION_DATABASE_URL='postgresql://wx_migrate:wx_migrate_local@127.0.0.1:55432/wx_upload'
export DATABASE_RUNTIME_ROLE='wx_runtime'
export DATABASE_MAINTENANCE_ROLE='wx_maintenance'
pnpm --filter @wx-upload/contracts build
pnpm --filter @wx-upload/api db:migrate
```

运行时与保留清理的固定本地连接分别是：

```text
postgresql://wx_runtime:wx_runtime_local@127.0.0.1:55432/wx_upload
postgresql://wx_maintenance:wx_maintenance_local@127.0.0.1:55432/wx_upload
```

不要把迁移或维护连接设置为 API 的 `DATABASE_URL`。

## 4. 生成小程序配置

开发者工具模拟器连接本机 API 时执行：

```bash
env NODE_ENV=development \
  PUBLIC_API_BASE_URL=http://127.0.0.1:3000 \
  pnpm --filter @wx-upload/miniprogram generate:config
```

这会生成已被 Git 忽略的 `apps/miniprogram/miniprogram/config.generated.ts`。真机不能把开发电脑的 `127.0.0.1` 当作 API；真机联调必须改为已备案并在微信后台登记的 HTTPS 测试域名，然后重新生成配置。

## 5. 启动 API

在同一终端准备本地开发变量：

```bash
export NODE_ENV=development
export HOST=127.0.0.1
export PORT=3000
export TRUST_PROXY=false
export MONITORING_TOKEN=local-monitoring-token
export DATABASE_URL='postgresql://wx_runtime:wx_runtime_local@127.0.0.1:55432/wx_upload'
export WECHAT_AUTH_MODE=stub
export WECHAT_APP_ID=example-app-id
export WECHAT_APP_SECRET=example-app-secret
export WECHAT_CODE2SESSION_ENDPOINT=https://api.weixin.qq.com/sns/jscode2session
export JWT_PRIVATE_KEY=temporary-development-key
export JWT_PUBLIC_KEY=temporary-development-key
export CURSOR_SIGNING_KEY=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI
export R2_ENDPOINT=http://127.0.0.1:59000
export R2_BUCKET=wx-private-media
export R2_ACCESS_KEY_ID=minio_local
export R2_SECRET_ACCESS_KEY=minio_local_secret
export R2_FORCE_PATH_STYLE=true
pnpm --filter @wx-upload/api build
pnpm --filter @wx-upload/api start
```

这些值只能用于本机开发；生产配置加载器会拒绝微信 stub、本地存储 endpoint 和临时签名密钥。

另开终端验证：

```bash
curl --fail http://127.0.0.1:3000/health/live
curl --fail \
  -H 'X-Monitoring-Token: local-monitoring-token' \
  http://127.0.0.1:3000/health/ready
```

## 6. 检查 MinIO

浏览器打开 `http://127.0.0.1:59001`，本地账号为 `minio_local`，密码为 `minio_local_secret`。只用它确认：

- bucket 仍是私有状态；
- 完成上传后存在 `users/<内部用户ID>/...` 对象；
- 客户端响应中没有存储路径与 multipart 标识。

## 7. 导入微信开发者工具

先构建共享 contracts：

```bash
pnpm --filter @wx-upload/contracts build
```

然后完成开发者工具导入：

1. 将 `apps/miniprogram/project.private.config.json.example` 复制为被 Git 忽略的 `project.private.config.json`，填入自己的测试 AppID。
2. 在微信开发者工具中导入 `apps/miniprogram` 目录。
3. 点击“工具 → 构建 npm”。项目的手动打包关系会把 workspace contracts 输出到 `apps/miniprogram/miniprogram/miniprogram_npm`；该目录已被 Git 忽略，不能提交。
4. 确认项目的 `miniprogramRoot` 为 `miniprogram/`，编译插件包含 TypeScript。
5. 确认开发者工具使用项目固定的基础库 `2.32.3` 或更高稳定版本；更低版本不支持本项目要求的显式隐私授权 API。
6. 使用 HTTPS 测试域名真机联调时，同时把该域名加入微信小程序的 request 与 uploadFile 合法域名。
7. 在微信公众平台《小程序用户隐私保护指引》中声明昵称收集及用途；未声明时真机 `<input type="nickname">` 不会显示微信昵称候选。

## 8. 测试与停止

API 集成/E2E 会对上述固定本地 `wx_upload` 数据库执行破坏性清空。运行前先停止本地 API，并确认该数据库与 MinIO bucket 只含可丢弃的开发数据；任何生产、预发布或个人重要数据都不能使用这些连接。

完整本地检查：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e:local
pnpm build
```

仅当明确配置了以下安全门和专用测试 bucket 凭据时，才运行真实 R2 smoke test；它不得指向生产 bucket，也不能与当前 `R2_BUCKET` 或 `MINIO_BUCKET` 相同：

```bash
export RUN_R2_SMOKE=true
export R2_SMOKE_ENDPOINT='https://<test-account-id>.r2.cloudflarestorage.com'
export R2_SMOKE_BUCKET='<dedicated-smoke-test-bucket>'
export R2_SMOKE_ACCESS_KEY_ID='<bucket-scoped-test-access-key>'
export R2_SMOKE_SECRET_ACCESS_KEY='<bucket-scoped-test-secret-key>'
pnpm --filter @wx-upload/api test:r2:smoke
```

测试只创建带唯一前缀的对象和 multipart，并在结束时删除/终止自己创建的测试数据。无 `RUN_R2_SMOKE=true` 时，凭据测试保持跳过，不属于无密钥 CI。

停止本地依赖但保留数据：

```bash
docker compose -f deploy/docker-compose.yml down
```
