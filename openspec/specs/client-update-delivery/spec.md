## Purpose

定义知萃安装客户端的网页构建发现、Windows 原生更新检查与安全发布边界，使更新可持续、可恢复且不会打断用户工作。

## Requirements

### Requirement: Installed clients discover deployed web builds
Windows 与 Android 客户端 SHALL 从不可缓存的公开版本标识发现已部署的网页构建变化，并 SHALL 在启动后、应用恢复可见时及低频轮询时重新检查；普通浏览器 MUST NOT 被强制执行客户端更新流程。

#### Scenario: New web build is deployed while client remains open
- **WHEN** 客户端检测到远端构建标识与当前加载标识不同
- **THEN** 客户端提示用户刷新，或仅在确定没有未完成交互时自动刷新

#### Scenario: Version endpoint is unavailable
- **WHEN** 客户端无法读取版本标识或响应无效
- **THEN** 当前页面继续可用且客户端稍后重试

#### Scenario: Browser visitor opens the marketing site
- **WHEN** 普通浏览器访问官网
- **THEN** 系统不展示安装客户端专用的网页构建刷新提示

### Requirement: Web refresh preserves active work
客户端 MUST NOT 在存在未提交输入、流式任务、下载或明确业务忙碌状态时后台强制刷新；用户确认刷新后 SHALL 加载最新文档与哈希资源。

#### Scenario: User is editing when a build changes
- **WHEN** 客户端发现新版且页面存在未完成工作
- **THEN** 客户端保持当前页面并提供用户触发的刷新操作

#### Scenario: User accepts refresh
- **WHEN** 用户在新版提示中确认刷新
- **THEN** 客户端绕过陈旧页面缓存并加载最新构建

### Requirement: Native desktop updates use a complete trusted feed
Windows 原生更新 MUST 通过 HTTPS 更新 feed 获取版本清单、版本化安装包和差分文件；发布流程 MUST 校验文件完整性并在产物全部可用后最后原子切换清单。

#### Scenario: New native release is published
- **WHEN** feed 中存在高于当前版本且校验有效的正式版本
- **THEN** 客户端发现并下载更新，下载完成后提示用户重启安装

#### Scenario: Feed is incomplete or unavailable
- **WHEN** 清单、安装包或差分文件缺失或校验失败
- **THEN** 客户端保持当前版本可用并报告可重试的更新错误

### Requirement: Desktop update checks continue during long-running sessions
打包后的 Windows 客户端 SHALL 在启动延迟后检查更新，在窗口重新获得焦点时检查，并以小时级间隔继续检查；检查 MUST 合并并发请求且 MUST NOT 在更新下载或等待安装时重复启动。

#### Scenario: Release appears after startup
- **WHEN** 用户长时间保持客户端运行且新版本在启动检查之后发布
- **THEN** 客户端在后续聚焦或定时检查中发现该版本

#### Scenario: Update is already downloading
- **WHEN** 定时器或聚焦事件在更新下载期间触发
- **THEN** 客户端复用当前状态且不发起第二个更新请求

### Requirement: Web and native update boundaries are explicit
系统 SHALL 将远端网页与 API 更新标识为无需重装可用，将 Electron main/preload、本地能力与安全策略更新标识为需要原生安装包和重启。

#### Scenario: Only web UI changes
- **WHEN** 发布内容仅涉及远端网页或后端 API
- **THEN** 客户端通过刷新获得新版且不要求重装桌面程序

#### Scenario: Electron native code changes
- **WHEN** 发布内容涉及 Electron 主进程、preload 或本地原生能力
- **THEN** 客户端要求下载并重启安装新的桌面版本

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
