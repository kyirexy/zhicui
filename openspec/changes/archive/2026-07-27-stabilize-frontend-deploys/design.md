## Context

当前部署脚本直接在 `/opt/zhicui/frontend` 中执行 `npm ci` 和
`npm run build`，而 systemd 管理的 Next.js 进程在整个构建期间仍从该目录读取模块
与按需加载的服务端 chunk。连续 Jenkins 构建还可能同时进入同一脚本。生产日志已出现
Next.js 运行时找不到当前依赖版本模块的错误，证明运行产物发生了混用。

生产服务器有足够磁盘空间，并已安装 `rsync` 与 `flock`。项目仍由 Jenkins 调用同一台
服务器上的 `deploy/deploy.sh`，无需引入容器或新的发布平台。

## Goals / Non-Goals

**Goals:**

- 构建过程不修改运行中前端所依赖的 `.next` 和 `node_modules`。
- 每台服务器同一时间最多执行一次部署。
- 切换失败或上线健康检查失败时恢复上一版前端产物。
- 对前端真实页面和后端 API 都做上线后验证。
- 消除站点 favicon 的稳定 404。

**Non-Goals:**

- 不改造为 Docker、蓝绿集群或多机部署。
- 不更换 Jenkins、systemd、Nginx 或 npm。
- 不修改业务数据、API 或鉴权逻辑。
- 不解决后端 Python 依赖的无停机升级。

## Decisions

### 双层串行化

Jenkinsfile 使用 `disableConcurrentBuilds()`，服务器脚本同时使用 `flock`。前者避免同一
Jenkins 任务并发，后者覆盖手工执行脚本以及其他入口。仅使用其中一层无法覆盖另一类
调用来源。

### 隔离构建并切换完整运行产物

前端源代码通过 `rsync` 复制到 `/opt/zhicui/.deploy-staging/<id>`，在该目录执行
`npm ci` 和 `npm run build`。成功后短暂停止前端服务，将完整的 `.next` 与
`node_modules` 切换到运行目录，再启动服务。这样 Next.js 不会同时读取两个版本。

曾考虑只切换 `.next`，但构建产物可能依赖新版本 npm 包；只切换一个目录仍可能出现
ABI 或模块路径不匹配。也曾考虑构建时始终停服，虽然更简单，但会把依赖安装和构建时间
全部变成用户可见停机，因此不采用。

### 保留单份可回滚产物

切换前把当前 `.next` 与 `node_modules` 移入固定备份目录。脚本通过退出 trap 捕获切换
期间的命令失败；双健康检查失败也视为发布失败。失败时删除新产物、恢复备份并重新启动
前端。成功后才清理备份与暂存目录。

### 双健康检查

后端继续检查 `/api/health`；前端额外请求 `http://127.0.0.1:3000/settings`。该路径会
执行真实 App Router 页面加载，比仅检查端口或静态根文件更能发现缺失 chunk 与
`node_modules` 不匹配。

### 使用真实 ICO 静态资源

从现有品牌 Logo 机械生成多尺寸 `frontend/public/favicon.ico`，保留布局中的
`/favicon.ico` 声明。这样网页端与静态导出的 Android 包均能得到同一品牌图标，无需
增加运行时路由。

## Risks / Trade-offs

- [隔离构建额外占用约一份 `node_modules` 空间] → 构建完成或失败后清理暂存目录，并只保留切换期间的一份备份。
- [停止前端到重新启动之间有数秒不可用] → 所有耗时安装和构建都在停服前完成，切换窗口只包含目录移动和服务启动。
- [首次启用脚本时旧产物不完整，无法回滚] → 切换前验证当前与暂存产物的关键目录；暂存验证失败不停止线上服务。
- [健康检查失败可能源于后端而非前端] → 仍恢复前端上一版，保留一致的发布回滚语义，并输出 systemd 状态辅助排查。

## Migration Plan

1. 提交 Jenkins、部署脚本与 favicon 变更。
2. 在本地完成前端生产构建和 Shell 语法检查。
3. 推送部署分支，由 Jenkins 运行新脚本。
4. 验证 `/api/health`、`/settings` 与 `/favicon.ico`。
5. 若新脚本在切换后失败，退出 trap 自动恢复上一版前端；必要时仍可从 Git 回退提交并重新触发 Jenkins。

## Open Questions

无。
