## ADDED Requirements

### Requirement: Windows installations provide durable launch shortcuts
Windows NSIS 安装器 SHALL 在全新安装和覆盖安装后创建指向当前正式可执行文件的“知萃”桌面快捷方式，并 SHALL 保留开始菜单快捷方式；卸载时 SHALL 由安装器清理这些入口。

#### Scenario: User performs a fresh installation
- **WHEN** 用户在 Windows 10 或 Windows 11 完成知萃安装
- **THEN** 桌面和开始菜单均存在名称为“知萃”的可用启动入口

#### Scenario: User upgrades an installation that has no desktop shortcut
- **WHEN** 用户覆盖安装更高版本且原桌面快捷方式缺失
- **THEN** 安装器重新创建指向新版本可执行文件的“知萃”桌面快捷方式

### Requirement: Desktop build identity is explicit
未打包的 Electron 开发运行 SHALL 在窗口标题和页面中明确标识“开发版 · 本地调试”；正式安装包 MUST 使用稳定版身份且 MUST NOT 展示开发标识。

#### Scenario: Developer launches the local desktop command
- **WHEN** Electron 以未打包开发模式启动
- **THEN** 窗口和页面均显示清晰的开发版身份，且正式产品名称不被冒充

#### Scenario: User launches the installed desktop application
- **WHEN** Electron 从正式安装目录以打包模式启动
- **THEN** 窗口标题和应用界面使用“知萃”稳定版身份且不显示开发徽标

### Requirement: Desktop releases verify installation identity before publication
Windows 发布流程 MUST 在公开上传前验证版本号、安装包与更新清单哈希，并 MUST 验证快捷方式配置和开发/正式身份契约；任一验证失败 SHALL 阻止发布。

#### Scenario: Installer shortcut policy regresses
- **WHEN** 构建配置不再保证覆盖安装重建桌面快捷方式
- **THEN** 发布验证失败且安装包不会更新到正式下载 feed

#### Scenario: Release artifacts are internally consistent
- **WHEN** 安装包版本、更新清单、文件大小、哈希及身份策略全部通过验证
- **THEN** 发布流程允许原子更新正式下载 feed
