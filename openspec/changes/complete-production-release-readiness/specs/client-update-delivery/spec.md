## ADDED Requirements

### Requirement: Windows 正式 feed 只接受可信签名包
Windows stable 更新清单 MUST 仅引用通过 Authenticode 身份、时间戳、哈希和安装身份验证的安装包；未签名产物 SHALL 进入明确标记的 beta 渠道或停止发布。

#### Scenario: 稳定包签名有效
- **WHEN** 安装包签名链、允许发布者身份、时间戳和清单哈希全部有效
- **THEN** 发布流程允许更新 stable feed

#### Scenario: 内测用户检查更新
- **WHEN** 客户端配置为 beta 渠道
- **THEN** 它只读取 beta feed 并在界面明确显示内测身份

### Requirement: Windows 更新安装前再次验证身份
客户端 SHALL 在提示重启安装前验证已下载文件的发布者身份和清单完整性；验证失败 MUST 删除或隔离下载并保持当前版本可用。

#### Scenario: 下载后文件被替换
- **WHEN** 本地安装包哈希或签名身份与清单不一致
- **THEN** 客户端拒绝执行并显示可重试的安全错误
