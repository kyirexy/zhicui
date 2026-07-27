## Why

现有管理端只能看到 HTTP 状态和用户动作，无法查看错误类型、脱敏消息与堆栈，遇到线上提取、Agent、下载器或客户端异常时仍需登录服务器翻日志。正式部署前需要建立可追踪且不泄露敏感内容的统一错误视图。

## What Changes

- 新增应用错误日志表，保存来源、级别、异常类型、脱敏消息、脱敏堆栈、接口模板、用户、状态码、IP 与时间。
- 捕获后端未处理异常、HTTP 错误、LLM 调用异常，以及已登录 Web/Capacitor 客户端的运行时错误。
- 增加受管理员权限保护的错误日志查询接口，支持时间、来源、级别筛选和分页汇总。
- 在“用量与日志”中加入“错误日志”标签，提供概览、筛选、列表和可展开的详细堆栈。
- 错误采集禁止保存请求正文、Authorization、密码、API Key、视频文案、用户问题或生成答案，并对常见密钥与 URL 参数再次脱敏。
- 同步生产 Capacitor 资源并构建新版 Android APK，随后提交代码和 APK，推送 Gitee 触发正式部署。

## Capabilities

### New Capabilities

- `detailed-error-observability`: 安全采集后端、LLM 与客户端错误，并向管理员提供详细、可筛选的排障视图。

### Modified Capabilities

无。错误观测规格尚未同步到 `openspec/specs/`。

## Impact

- 后端新增一张 SQLAlchemy 表、错误采集服务、全局异常处理和管理员/客户端错误 API。
- LLM 调用辅助层增加失败记录，但观测失败不得改变原业务异常。
- 前端 Providers 增加轻量客户端错误上报器，管理端观测组件增加错误标签。
- Capacitor 静态资源和 `frontend/public/download/zhicui.apk` 更新。
- 不引入新的运行时依赖；新表继续通过 `Base.metadata.create_all()` 创建。
