## Context

知萃当前通过作用域隔离的 `jiji262/douyin-downloader` sidecar 同步抖音喜欢、收藏和自己的作品。真实账号对照测试显示：同一份扫码登录态在 `juziguai/douyin-mcp-server` 中可以读取 5 条喜欢，但当前 downloader 的喜欢与收藏请求均触发 HTTP 403；downloader 随后仍以 `Total 0 / Failed 0` 结束，主服务和前端因此显示“检查 0 条”。收藏失败还具有明确的 `UIFID` / Argus 会话前置条件，继续盲目重试只会增加风控概率。

现有架构已经具备用户作用域 Cookie、手动同步、任务诊断、浏览器回退和 `needs_action` 字段。本次修复应复用这些边界，不新增一个持有全局 Cookie 的第二生产 sidecar，也不把第三方 CLI 直接暴露给用户。

## Goals / Non-Goals

**Goals:**

- 让抖音喜欢列表优先使用从实测可用项目移植的参数模板和请求判定，并保留受控回退。
- 在收藏请求前验证 `UIFID` 等必要会话上下文，缺失时立即进入可操作状态。
- 让 401/403、验证码、登录失效、缺少会话字段和真实空列表具有互斥、稳定的错误代码。
- 让主服务与前端准确显示失败来源、建议动作和冷却时间，不再把受限状态算作成功的 0 条。
- 保持用户作用域隔离，并保证日志、API 和数据库不包含 Cookie 或签名参数。

**Non-Goals:**

- 不绕过验证码、私密、付费或平台访问控制。
- 不恢复自动同步，不提高 1–100 条的手动同步上限。
- 不引入第二套持久化抖音账号服务，不把 `douyin-mcp-server` 的 Cookie 文件直接用于生产多用户请求。
- 不在本次变更中重做博主主页公开作品同步或媒体转写链路。

## Decisions

### 1. 在现有 sidecar 内移植已验证的喜欢请求路径

生产仍固定并隔离 `jiji262/douyin-downloader`。从 MIT 许可的参考实现中移植喜欢接口所需的安全请求参数、Referer 和成功响应判定，形成 sidecar 内的 metadata-only 私有列表适配器。选择移植而不是直接启动第二 sidecar，是因为现有 sidecar 已经实现每用户 scope、任务取消、熔断、媒体即时流和生产部署约束；第二个全局 Cookie 工具会破坏这些安全边界。

喜欢请求只有在 HTTP 成功、响应状态成功且明确包含合法 `aweme_list` 时才算一次成功发现。403、挑战页、非 JSON、缺失关键字段均返回分类错误，不能返回空成功。

### 2. 把收藏就绪状态作为登录态能力而不是 Cookie 明文

sidecar 的 `/api/v1/cookies` 安全响应增加 `private_list_readiness`：只返回 `like_ready`、`collection_ready` 和受控的 `missing_requirements` 枚举，不返回值。收藏缺少 `UIFID` 时，`auto-collect` 在创建任务前返回或创建一个 `needs_action` 失败任务，错误代码为 `argus_uifid_missing`，并提示用户重新捕获浏览器登录态。

扫码登录完成后 sidecar 从同一作用域的浏览器上下文同步新 Cookie，并再次计算 readiness；不把 `UIFID_TEMP` 冒充为 `UIFID`。若平台仍未下发所需字段，账号可保持“已连接”，但收藏单独显示“需要重新验证”，喜欢与自己的作品仍可使用。

### 3. 用稳定诊断码贯穿 sidecar、主服务和前端

允许的私有列表错误码扩展为：`argus_uifid_missing`、`risk_controlled`、`verification_required`、`session_expired`、`network_error`、`connector_error`。主服务只暴露枚举、短消息、`needs_action` 和有界 `retry_after_seconds`；未知上游文本归一为 `connector_error`。

`risk_controlled` 和 `argus_uifid_missing` 不自动紧密重试。前端分别给出“暂时受到平台限制，请稍后再试”和“收藏登录信息不完整，请重新连接账号”的中文提示。

### 4. 汇总成功必须建立在来源级成功之上

同步聚合器按来源记录 `succeeded / failed / needs_action`。来源返回 0 条只有在连接器明确报告完整成功时才计为成功空列表；任何错误码或 `needs_action` 都不增加成功来源数，并在汇总中保留失败来源名称。已有资料保持不变。

### 5. 所有连接器日志使用路径级诊断

日志只记录接口路径、HTTP 状态、错误枚举、耗时和有界计数。禁止记录完整 URL、查询串、Cookie、签名、响应原文和浏览器存储值。测试显式扫描这些敏感字段不会出现在持久层或 API 响应。

## Risks / Trade-offs

- [平台继续调整私有接口] → 使用契约测试固定成功/403/挑战响应形状，未知响应安全失败并保留公开作品功能。
- [收藏所需 UIFID 无法通过普通扫码获得] → 清楚显示为收藏能力未就绪，允许用户重新捕获浏览器会话；不伪造、不无限重试。
- [移植参数模板后喜欢仍按账号受限] → 保留来源级风控错误和冷却时间，不降级成空列表。
- [滚动部署期间新旧 sidecar 响应不同] → 主服务对 readiness 字段向后兼容；字段缺失时不阻断喜欢，但收藏失败仍按任务诊断处理。

## Migration Plan

1. 先发布主服务的错误码兼容、准确汇总和前端提示；旧 sidecar 仍可运行。
2. 安装固定版本的新 sidecar 补丁，运行健康检查及假响应契约测试。
3. 用小账号分别冒烟测试喜欢成功、收藏缺少 UIFID、真实空列表和重新登录。
4. 健康检查通过后重启主服务；已有 Cookie、资料、文稿和计划不迁移、不删除。
5. 如喜欢读取出现回归，回滚 sidecar release 软链接；主服务的新错误分类仍可兼容旧响应。

## Open Questions

- 抖音是否会在后续扫码流程中稳定下发 `UIFID`；若仍不稳定，需要在下一变更中评估受控的浏览器扩展会话交接，而不是扩大本次 HTTP 适配范围。
