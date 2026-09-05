## ADDED Requirements

### Requirement: macOS 桌面行为
应用 SHALL 支持 macOS 原生菜单、关闭窗口后通过 Dock 重开，以及启动前到达的协议链接。

#### Scenario: 冷启动链接
- **WHEN** macOS 在 ready 之前发送 zhicui 链接
- **THEN** 应用保留该链接并在窗口创建时处理

### Requirement: 本机 Agent 跨平台连接
桌面程序与 CLI SHALL 在 macOS 使用相同的私有描述文件目录，同时保留用户身份和请求校验。

#### Scenario: Mac 描述文件
- **WHEN** 已登录的 Mac 客户端运行
- **THEN** CLI 可从 ~/Library/Application Support/Zhicui 发现它

### Requirement: 双架构构建和发布隔离
构建流程 SHALL 生成 arm64 与 x64 的 dmg/zip，测试构建不自动更新，签名构建使用专属 Mac 更新源。

#### Scenario: 无苹果证书
- **WHEN** 手动执行测试构建
- **THEN** 云端无需苹果证书即可构建测试产物，并且不发布到正式下载站

#### Scenario: 正式模式缺少凭据
- **WHEN** 选择签名公证构建但凭据不完整
- **THEN** 工作流失败，不降级发布未签名包

### Requirement: 授权的测试下载发布
用户明确授权后系统 SHALL 允许将 Mac 测试包发布到正式域名的独立测试目录，保留未公证标识与源提交，并校验公网产物哈希。

#### Scenario: 测试包部署
- **WHEN** 用户要求发布当前 Mac 测试安装包
- **THEN** 下载路径包含 test 与源提交，正式更新通道保持不变，下载字节与云端产物一致
