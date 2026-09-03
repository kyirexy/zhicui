## ADDED Requirements

### Requirement: 设置页提供 Agent 接入中心而非终端
网页 SHALL 在“设置 → Agent 接入”提供安装命令、远程 MCP 配置、授权/PAT、连接设备、scopes、最近调用和吊销操作，MUST NOT 提供网页命令终端或任意 Shell 输入。

#### Scenario: Web 用户打开接入中心
- **WHEN** 已登录用户从设置进入 Agent 接入
- **THEN** 页面展示跨平台 npm/npx 安装和远程 MCP 配置
- **AND** 页面不渲染终端模拟器或执行任意命令的控件

### Requirement: PAT 的秘密只显示一次
接入中心 SHALL 在创建 PAT 后只显示一次完整令牌，并 SHALL 要求用户复制后关闭；刷新或重新进入页面 MUST NOT 再返回完整令牌。

#### Scenario: 用户创建只读 PAT
- **WHEN** 用户选择只读 scopes 并创建 PAT
- **THEN** 页面一次性显示令牌与安全保存提示
- **AND** 后续列表只显示前缀与非敏感元数据

### Requirement: Windows 提供固定 Agent 连接与诊断动作
受信任 Windows 客户端 SHALL 显示“连接 Codex”“连接 Claude Code”和本机能力诊断，并 SHALL 仅调用 preload 白名单中的固定安装/诊断动作；普通 Web、macOS/Linux Web 与 Android MUST 隐藏这些本机执行按钮。

#### Scenario: Windows 客户端连接 Claude Code
- **WHEN** 用户点击“连接 Claude Code”
- **THEN** Electron 主进程调用受限配置安装器并返回结构化结果
- **AND** 渲染进程不能传入 Shell 命令、任意路径或原始凭证

#### Scenario: Android 打开接入中心
- **WHEN** Android 用户打开 Agent 接入
- **THEN** 页面只展示授权连接、权限和吊销管理
- **AND** 不声称可运行 CLI 或本机采集动作

### Requirement: 用户可理解并最小化权限
接入中心 SHALL 用中文解释每个 scope 允许的能力和风险，默认选择最小只读权限，并 SHALL 在创建、扩大权限或吊销连接后即时刷新状态。

#### Scenario: 用户选择同步权限
- **WHEN** 用户勾选 `creator:sync` 或资料写入 scope
- **THEN** 页面明确提示同步仍只会在用户或 Agent 显式调用时发生
- **AND** 不启用自动同步、后台轮询或风控重试

### Requirement: 最近调用记录脱敏且可追踪
接入中心 SHALL 展示 Action、凭证前缀、时间、状态和 request/run ID，MUST NOT 展示完整输入中的秘密、Cookie、JWT、API Key、本机路径或临时媒体 URL。

#### Scenario: 用户排查失败调用
- **WHEN** 用户查看最近失败的 Action
- **THEN** 页面展示稳定错误码和可操作说明
- **AND** 不暴露原始模型提示、完整文稿或认证秘密

