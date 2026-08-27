# Desktop Douyin Private Sync Specification

## Purpose

Define secure, user-triggered Douyin likes, collections, and own-post discovery in the trusted Windows client while keeping private browser credentials on the user's device.

## Requirements

### Requirement: Windows client keeps Douyin private session local
系统 SHALL 在受信任的 Windows Electron 客户端中使用按知萃用户隔离的本机 Chrome 或 Edge 持久会话连接抖音，并 MUST NOT 将 Cookie、LocalStorage、签名参数或浏览器 profile 路径发送到渲染进程或服务器。

#### Scenario: User connects Douyin for the first time
- **WHEN** 已登录知萃用户在 Windows 客户端点击连接抖音
- **THEN** 客户端打开抖音官方页面并等待用户完成登录
- **AND** 登录态仅保存在该知萃用户对应的本机会话目录

#### Scenario: Another Zhicui user uses the same computer
- **WHEN** 同一台电脑切换到另一个知萃账号
- **THEN** 系统使用不同的抖音 profile
- **AND** 新用户不能读取前一用户的登录态或私人来源

### Requirement: Private sources are collected on the user's device
Windows 客户端 SHALL 从当前登录账号的官方页面读取喜欢、收藏和自己的作品，SHALL 将每次结果限制在 1–100 条，并 SHALL 只返回规范化作品链接与公开元数据。

#### Scenario: User manually syncs likes
- **WHEN** 登录有效的用户选择喜欢并点击同步 50 条
- **THEN** 客户端使用本机网络读取最近最多 50 条喜欢作品
- **AND** 不由云端数据中心 IP 请求该私人列表

#### Scenario: User syncs multiple source modes
- **WHEN** 用户选择喜欢、收藏或自己的作品中的一个或多个来源
- **THEN** 系统分别保留每个作品的来源模式与来源顺序
- **AND** 相同作品不会在可见资料库中重复出现

#### Scenario: Requested count is invalid
- **WHEN** 渲染进程提交小于 1 或大于 100 的数量
- **THEN** Electron 主进程拒绝请求且不启动浏览器任务

### Requirement: Healthy manual sync stays unobtrusive
系统 SHALL 只在用户明确点击后启动抖音同步，且在持久会话有效并能自动定位来源页面时 SHALL 保持浏览器最小化；系统 MUST NOT 定时追更或自动重试失败任务。

#### Scenario: Existing session remains valid
- **WHEN** 用户点击同步且本机抖音会话仍有效
- **THEN** 客户端在后台最小化读取并持续报告已发现数量
- **AND** 不主动把抖音页面带到前台

#### Scenario: Platform requires user verification
- **WHEN** 抖音要求验证码、重新登录或无法自动定位当前用户主页
- **THEN** 客户端停止自动读取并显示可操作原因
- **AND** 仅在用户选择继续验证时显示抖音官方页面

### Requirement: Local results use a bounded metadata contract
系统 SHALL 向服务器提交最多 100 条经过规范化的抖音作品，MUST 拒绝 Cookie、完整请求头、签名媒体 URL、本机路径和未知扩展数据，并 SHALL 按 JWT 用户隔离幂等保存。

#### Scenario: Valid local discovery is ingested
- **WHEN** 受信任桌面流程提交作品 ID、canonical URL、标题、作者、封面、发布时间和来源顺序
- **THEN** 服务器为当前用户幂等更新 metadata snapshot 与来源台账
- **AND** 返回接受、复用和拒绝计数

#### Scenario: Sensitive or malformed fields are submitted
- **WHEN** 请求包含无效抖音 URL、超长字段、Cookie 字段或本机文件路径
- **THEN** 服务器拒绝相关内容且不将其写入数据库或日志

### Requirement: Desktop capability is explicitly versioned
前端 SHALL 仅在可信 preload bridge 明确报告抖音本地同步能力时启用本地流程，普通 Web、Android 和旧客户端 SHALL 保留安全的替代入口。

#### Scenario: Updated Windows client opens the sync sheet
- **WHEN** bridge 支持 `douyin` 本地账号 provider
- **THEN** 界面显示本机连接、手动同步和本机状态

#### Scenario: Web or old client opens the sync sheet
- **WHEN** 当前运行时没有对应 bridge 能力
- **THEN** 界面不声称能够本机读取私人列表
- **AND** 继续提供分享链接导入或更新 Windows 客户端的操作
