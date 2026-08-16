## Why

知萃已经支持平台基础 AI 和用户自带 OpenAI 兼容供应商，但缺少一个可自托管的统一路由层来聚合多供应商、自动回退并控制成本。OmniRoute 提供 OpenAI 兼容网关，适合作为可选的中间层，同时不改变用户零配置使用知萃基础 AI 的默认路径。

## What Changes

- 将 MIT 许可的 OmniRoute 源码固定在项目 `integrations/OmniRoute`，保留独立升级边界和上游提交信息。
- 新增可选 OmniRoute 运行时配置，知萃后端通过其 OpenAI 兼容 `/v1` 接口调用 `auto` 或管理员指定模型。
- 扩展用户 AI 服务选择为“知萃基础 AI / OmniRoute 智能路由 / 其他 OpenAI 兼容供应商”。
- OmniRoute 未配置或不可用时不影响默认平台 AI；用户自带 API Key 继续加密存储且前端只显示掩码。
- 在 Windows 桌面侧栏左下区域新增“AI 路由”入口，打开独立的 AI 路由工作台；移动端也可使用同一响应式页面。
- 独立工作台通过知萃后端的安全适配层读取 OmniRoute 实时模型目录、免费层和健康状态；主界面只提供搜索与整行点击选模型，高级供应商和控制台能力降级为次级入口。
- 管理员可从工作台进入受 OmniRoute 自身认证保护的高级控制台，普通用户不会获得管理地址、共享密钥或供应商凭据。
- 提供本地/服务器部署模板、环境变量示例、健康检查和连接说明，不自动启动或暴露 OmniRoute 管理面板到公网。

## Capabilities

### New Capabilities

- `omniroute-ai-gateway`: 定义 OmniRoute 源码边界、运行时配置、可用性、路由回退和部署安全要求。
- `user-ai-routing-control`: 定义用户在基础 AI、OmniRoute 和自带兼容供应商之间选择、测试与恢复默认的前端和 API 行为。

### Modified Capabilities


## Impact

- 第三方源码：`integrations/OmniRoute`（上游 MIT 项目，独立 Git 工作树）。
- 后端配置与用户供应商解析：`core/config.py`、`services/user_ai_provider_service.py`、用户 AI 服务 API 与测试。
- 前端路由工作台、设置和桌面侧栏：`/ai-routing`、`UserAIProviderSettingsCard`、`DesktopAppFrame` 及对应样式和 API 类型。
- 部署：新增 OmniRoute Compose 模板和环境变量说明；默认仍由现有 LLM 配置提供基础 AI。
