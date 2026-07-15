# 微信私有素材上传

这是一个微信小程序与自建 HTTPS API 组成的私有素材上传系统。用户在小程序内完成微信登录、确认微信昵称、选择图片或视频并进行二次确认；API 将 8 MiB 分片流式写入 Cloudflare R2，并在 PostgreSQL 中保存用户映射、上传状态和历史记录。

## 安全边界

- 小程序只连接 Nginx 暴露的 `/v1` HTTPS API，不持有微信 AppSecret、R2 凭据、JWT 私钥或数据库密码。
- R2 bucket 保持私有；API 不返回 object key、multipart upload ID、存储凭据或下载地址。
- 每个对象由服务端按内部 `userId` 生成前缀，客户端不能指定存储路径。
- API、迁移和保留清理分别使用 `wx_runtime`、`wx_migrate`、`wx_maintenance` 数据库角色。
- 生产配置强制真实微信登录、Cloudflare R2 HTTPS endpoint、Ed25519 密钥和独立监控令牌。

## 仓库结构

```text
apps/api/                 Fastify API、后台上传收口任务和数据库迁移
apps/miniprogram/         微信小程序
packages/contracts/       前后端共享接口契约
deploy/                   本地依赖与生产容器/Nginx 配置
docs/api/                 API 文档
docs/database/            数据库设计
docs/runbooks/            开发、部署、监控和真机验收手册
```

## 开始开发

环境要求为 Node.js 24、pnpm 11、Docker Compose、微信开发者工具和微信基础库 2.32.3 或更高版本。完整命令、固定的本地数据库连接和 MinIO 检查方式见 [本地开发手册](docs/runbooks/local-development.md)。

常用质量命令：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

本地跨端流程使用真实 PostgreSQL 和私有 MinIO，通过以下命令顺序运行 API 与小程序服务层 E2E：

```bash
pnpm test:e2e:local
```

## 生产交付

生产 Compose 只包含 Nginx、API、PostgreSQL、一次性迁移任务，以及按计划任务调用的保留清理 profile。Cloudflare R2 是外部私有存储，生产环境不启动本地对象存储或微信模拟网关。

上线前依次阅读：

1. [生产密钥与部署](docs/runbooks/production-secrets.md)
2. [监控与故障处理](docs/runbooks/monitoring.md)
3. [真机手工验收](docs/runbooks/manual-acceptance.md)

接口与数据结构分别以 [API 文档](docs/api/media-upload-api.md) 和 [数据库设计](docs/database/media-upload-database.md) 为准。
