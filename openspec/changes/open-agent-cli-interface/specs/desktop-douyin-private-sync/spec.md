## ADDED Requirements

### Requirement: 本机平台 Action 与 Electron 共用隔离核心和互斥锁
系统 SHALL 将平台会话路径推导、用户隔离、输入校验、结果规范化和锁键下沉到 Electron 与 CLI 本地 MCP 可共用的 `desktop-core`，并 SHALL 按知萃用户、平台和操作使用跨进程互斥；原始 Cookie、profile 路径与签名参数 MUST NOT 离开本机核心。

#### Scenario: Agent 与界面同时请求喜欢同步
- **WHEN** 同一知萃用户的 CLI Agent 和 Electron 界面同时对抖音喜欢发起同步
- **THEN** 只有一个采集任务获得用户+平台锁
- **AND** 另一个调用返回稳定的 `LOCAL_ACTION_BUSY`，不启动第二个浏览器或自动排队

#### Scenario: Agent 发起需要扫码的平台登录
- **WHEN** 本机 MCP 调用平台登录且当前会话需要扫码或验证码
- **THEN** Run 进入 `waiting_for_user` 并由受信桌面展示官方页面
- **AND** MCP 事件只包含操作状态，不包含 Cookie、浏览器 profile 或验证码原文

