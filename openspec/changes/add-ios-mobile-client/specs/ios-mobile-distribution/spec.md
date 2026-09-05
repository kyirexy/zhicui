## ADDED Requirements

### Requirement: iOS 使用原生移动工作台
系统 SHALL 将 iOS 和 Android 识别为已安装移动客户端，提供原生登录、首页与底部导航，不导向官网下载页。

#### Scenario: iOS 启动
- **WHEN** Capacitor 原生平台为 ios
- **THEN** 系统使用移动端身份与认证，扫码入口可用且不触发 Android 专属更新插件。

### Requirement: iOS 构建与分发真实区分
系统 MUST 提供可重复 iOS 云端构建，且模拟器产物 MUST NOT 被作为 iPhone 安装包公开。

#### Scenario: 缺少苹果签名
- **WHEN** 苹果签名和分发凭据尚未配置
- **THEN** 只能生成模拟器测试产物，并保留待签名和真机验收任务，不能声称已发布 iPhone 安装包。
