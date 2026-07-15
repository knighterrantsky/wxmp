# GitHub Actions、GHCR 与生产自动部署

## 1. 交付链路

当前实现使用一条受控链路：

```text
pull request / main push
        |
        v
GitHub 托管 runner：格式、类型、测试、E2E、构建
        |
        v（仅 main 且验证全部成功）
GitHub 托管 runner：构建 API 镜像并推送私有 GHCR
        |
        v（仅显式开启生产开关）
服务器 self-hosted runner：按 40 位 commit SHA 拉取并运行 Compose
```

服务器不再从源码构建 API。`main` 标签只方便查看，生产部署始终使用完整的 40 位 Git commit SHA；因此同一次发布可准确审计和回滚。

这条 Docker 链路只交付后端 API。微信小程序代码仍需使用生产 `PUBLIC_API_BASE_URL` 生成配置，再通过微信开发者工具或后续单独配置的微信 CI 完成上传、审核和发布；小程序代码不部署到这台服务器。

## 2. GitHub 仓库准备

1. 创建 private GitHub repository，把本地仓库推送上去。
2. 在 `Settings -> Actions -> General -> Workflow permissions` 允许工作流读取源码并写入 packages。如果组织策略限制 `packages: write`，需要由组织管理员放行。
3. 保持 GHCR package 为 private。第一次发布后，在 package 的 `Manage Actions access` 中确认当前 repository 具有读取权限。
4. 建议保护 `main`，要求 `CI / verify` 成功后才能合并；同时限制直接 push 和对 `.github/workflows/**`、`deploy/**` 的未审核修改。
5. 暂时不要创建 `ENABLE_PRODUCTION_DEPLOY`，这样 `publish` 会工作，但 `deploy` 会安全跳过。

工作流只把 `GITHUB_TOKEN` 用于当前仓库的 GHCR 推送和拉取。微信 AppSecret、R2 S3 密钥、数据库密码、JWT 私钥、监控令牌和 TLS 私钥都不保存为 GitHub secrets，也不会进入镜像。

## 3. 一次性服务器初始化

服务器当前是 Ubuntu 24.04。把初始化脚本复制到服务器并以 root 执行：

```bash
scp deploy/scripts/bootstrap-ubuntu.sh root@117.72.174.2:/root/
ssh root@117.72.174.2 'chmod 700 /root/bootstrap-ubuntu.sh && /root/bootstrap-ubuntu.sh'
```

脚本会完成：

- 安装 Docker Engine、Buildx 和 Compose plugin；
- 创建 `wxdeploy` 专用账号并加入 `docker` 组；
- 创建 `/opt/wx-private-media-upload` 发布目录；
- 创建 `/etc/wx-private-media-upload/production.env`，权限为 `root:wxdeploy 0640`；
- 在没有 swap 时创建 2 GiB `/swapfile`；
- 为 Docker JSON 日志设置单文件 10 MiB、最多 3 个文件的轮转。

`docker` 组等价于高权限主机访问，因此 `wxdeploy` 只能运行可信的生产工作流。不要把 pull request、fork 或任意命令工作流分配到带 `production` 标签的 runner。

## 4. 配置生产环境文件

以 `.env.example` 为清单，把真实值写入服务器文件：

```bash
sudoedit /etc/wx-private-media-upload/production.env
sudo chown root:wxdeploy /etc/wx-private-media-upload/production.env
sudo chmod 640 /etc/wx-private-media-upload/production.env
```

其中 API 镜像名与 SHA 由流水线在进程环境中覆盖；其余占位值必须全部替换。TLS 文件必须先放到服务器并使用绝对路径。完整密钥要求见 [生产密钥与部署手册](production-secrets.md)。

配置完成后只检查文件权限，不输出文件内容：

```bash
sudo stat -c '%U:%G %a %n' /etc/wx-private-media-upload/production.env
```

预期为 `root:wxdeploy 640`。

## 5. 注册生产 self-hosted runner

在 GitHub repository 的 `Settings -> Actions -> Runners -> New self-hosted runner` 选择 Linux、x64。GitHub 会生成带短期注册 token 的下载和配置命令。

在服务器上创建 runner 目录，并以 `wxdeploy` 身份执行 GitHub 页面给出的下载、校验和 `config.sh` 命令。配置命令应包含独立名称和生产标签：

```bash
sudo -iu wxdeploy
mkdir -p ~/actions-runner
cd ~/actions-runner
# 在这里执行 GitHub 页面显示的下载与校验命令
./config.sh \
  --url https://github.com/<owner>/<repository> \
  --token <short-lived-registration-token> \
  --name wx-upload-production \
  --labels production \
  --unattended
exit
```

然后按 GitHub 页面说明，把 runner 安装为系统服务，并指定 `wxdeploy` 用户：

```bash
cd /home/wxdeploy/actions-runner
./svc.sh install wxdeploy
./svc.sh start
./svc.sh status
```

回到 GitHub 确认 runner 为 `Idle`，标签至少包含 `self-hosted`、`Linux`、`X64`、`production`。

## 6. 开启第一次自动部署

在以下条件都满足后再开启：

- `api.rwseeding.com` 已指向服务器；
- Cloudflare SSL/TLS 模式为 `Full (strict)`；
- 服务器 TLS 证书覆盖 `api.rwseeding.com`；
- production.env 已填写且权限正确；
- runner 在线；
- 微信后台已登记同一个 HTTPS 合法域名。

在 GitHub `Settings -> Secrets and variables -> Actions -> Variables` 新建 repository variable：

```text
ENABLE_PRODUCTION_DEPLOY=true
```

下一次合并或 push 到 `main` 会先跑完整验证，再发布镜像，最后由生产 runner 部署。也可以在开启变量后提交一个只改文档的受控 commit 来触发首次流程。

部署完成后检查：

```bash
curl --fail https://api.rwseeding.com/health/live
sudo -u wxdeploy docker compose \
  --project-name wx-private-media-upload-production \
  --env-file /etc/wx-private-media-upload/production.env \
  --file /opt/wx-private-media-upload/current/deploy/docker-compose.prod.yml \
  ps
```

## 7. 失败与回滚

部署脚本使用目录锁，避免两个发布并发执行；只有 Compose 配置校验、镜像拉取、数据库迁移和健康等待全部成功后，`current` 才会指向新 release。失败时先查看 GitHub job 和容器日志，不要跳过 migration。

已经成功过的 release 会保存在 `/opt/wx-private-media-upload/releases/<commit-sha>`。应用回滚使用旧 SHA 和旧 release 配置：

```bash
sudo -iu wxdeploy
docker login ghcr.io
. /opt/wx-private-media-upload/release.env
old_sha=<previous-40-character-commit-sha>
/opt/wx-private-media-upload/bin/deploy-release.sh \
  "$API_IMAGE" \
  "$old_sha" \
  "/opt/wx-private-media-upload/releases/$old_sha"
docker logout ghcr.io
```

该操作只回滚容器镜像和部署配置，不反向执行数据库 migration。数据库变更必须遵守 expand/contract 兼容策略。

## 8. 当前尚需的外部信息

本地仓库目前还没有 GitHub remote，因此无法完成以下两步：

- 推送分支并实际产生 GHCR package；
- 获取 repository 专属的 runner 注册 token。

确定 GitHub 的 `<owner>/<repository>` 后即可继续，不需要重写当前流水线。
