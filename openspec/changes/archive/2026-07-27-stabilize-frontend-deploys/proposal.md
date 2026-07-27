## Why

生产环境的 Next.js 服务在 Jenkins 连续部署时会继续读取被原地替换的
`node_modules` 与 `.next`，从而出现模块版本混用和短暂 500。站点同时显式引用了
不存在的 `/favicon.ico`，导致每次访问都产生 404。

## What Changes

- 串行化 Jenkins 与服务器端部署，避免多个构建同时修改生产目录。
- 在隔离目录安装依赖和构建前端，构建完成后再短暂停服切换完整产物。
- 保留上一版前端产物，在切换或健康检查失败时自动回滚。
- 部署完成后同时检查后端健康接口与真实前端页面。
- 提供有效的站点 favicon，消除 `/favicon.ico` 404。

## Capabilities

### New Capabilities

- `production-deploy-safety`: 规定生产部署的串行、隔离构建、原子切换、失败回滚和前后端健康检查行为。

### Modified Capabilities

无。

## Impact

- `Jenkinsfile`：禁止同一任务并发执行。
- `deploy/deploy.sh`：增加主机锁、隔离构建、产物切换、回滚与双健康检查。
- `frontend/public/favicon.ico` 与根布局元数据：补齐浏览器图标资源。
- 不变更业务 API、数据库结构或用户数据。
