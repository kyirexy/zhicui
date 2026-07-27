## Purpose

保证知萃生产部署不会把运行中的前端置于依赖与构建产物不一致的状态，并能在新版本异常时
自动恢复上一版。

## Requirements

### Requirement: Deployments are serialized
生产部署系统 MUST 保证同一 Jenkins 任务与同一目标服务器在任意时刻最多执行一个部署。

#### Scenario: A deployment is already running
- **WHEN** 另一项 Jenkins 构建或手工部署在前一项部署完成前启动
- **THEN** 后续部署等待获得部署锁，且不得同时修改生产目录

### Requirement: Frontend builds are isolated from the live runtime
部署系统 SHALL 在独立暂存目录安装前端依赖并生成生产构建，构建期间不得修改运行中
Next.js 进程使用的 `.next` 或 `node_modules`。

#### Scenario: A new frontend version is building
- **WHEN** npm 正在安装依赖或执行生产构建
- **THEN** 当前前端服务继续使用上一版完整的 `.next` 与 `node_modules`

#### Scenario: A staged build fails
- **WHEN** 依赖安装、构建或产物验证失败
- **THEN** 部署失败并清理暂存目录，当前前端服务和产物保持不变

### Requirement: Runtime artifacts switch as one release
部署系统 MUST 仅在暂存产物验证成功后切换完整的 `.next` 和 `node_modules`，并将停机
窗口限制在产物切换和服务启动阶段。

#### Scenario: A staged build is ready
- **WHEN** 暂存构建包含有效的 Next.js 构建标识、服务器产物和依赖
- **THEN** 系统短暂停止前端、切换整套运行产物并启动新版本

### Requirement: Failed releases roll back
部署系统 MUST 在产物切换、服务启动或上线健康检查失败时恢复上一版前端运行产物。

#### Scenario: The new frontend does not become healthy
- **WHEN** 新产物切换后前端页面未在规定时间内成功响应
- **THEN** 系统恢复上一版 `.next` 与 `node_modules` 并重新启动前端服务

### Requirement: Production health checks cover frontend and backend
部署完成的判定 MUST 同时要求后端健康接口与真实前端设置页成功响应。

#### Scenario: Only one service is healthy
- **WHEN** `/api/health` 或 `/settings` 任一检查失败
- **THEN** 部署不得报告成功

#### Scenario: Both services are healthy
- **WHEN** `/api/health` 与 `/settings` 均成功响应
- **THEN** 部署可以报告成功并清理回滚备份

### Requirement: Site favicon is available
前端 SHALL 在 `/favicon.ico` 提供有效的品牌图标资源。

#### Scenario: Browser requests the favicon
- **WHEN** 浏览器请求 `/favicon.ico`
- **THEN** 服务器返回成功响应和可解析的 ICO 图标，不产生 404
