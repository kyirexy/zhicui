# mobile-app-updates Specification

## Purpose

定义知萃 Android 客户端发现新版本、展示更新日志、通过可信系统浏览器下载 APK，以及保持线上发布清单和原生构建版本一致的行为。

## Requirements

### Requirement: Android client discovers newer releases
系统 SHALL 仅在 Android Capacitor 客户端启动时读取原生安装构建号并获取公开的线上版本清单；当线上构建号大于安装构建号时 SHALL 展示更新提示。

#### Scenario: Older Android build starts
- **WHEN** Android 客户端的安装构建号小于线上清单构建号
- **THEN** 客户端展示包含最新版本号和更新日志的更新提示

#### Scenario: Current Android build starts
- **WHEN** Android 客户端的安装构建号等于或大于线上清单构建号
- **THEN** 客户端不展示自动更新提示

#### Scenario: Web client opens
- **WHEN** 用户通过普通浏览器访问知萃
- **THEN** 系统不执行 Android 原生自动更新弹窗流程

### Requirement: Release manifest is public and cache resistant
系统 SHALL 在无需登录的 HTTPS 地址提供最新版本、整数构建号、发布时间、APK 下载地址、文件大小和中文更新日志，并且客户端 SHALL 绕过缓存获取检查结果。

#### Scenario: Unauthenticated client checks release
- **WHEN** 未登录的 Android 客户端请求最新版本清单
- **THEN** 系统返回完整版本信息且不要求 JWT

#### Scenario: Cached manifest exists
- **WHEN** WebView 或中间缓存保存了旧版本清单
- **THEN** 客户端使用禁用缓存和唯一查询参数请求最新内容

#### Scenario: Manifest is invalid
- **WHEN** 版本清单缺少必要字段、构建号无效或下载地址不安全
- **THEN** 客户端拒绝该清单且不展示错误更新入口

### Requirement: Update prompt is informative and non-blocking
更新提示 SHALL 展示最新版本、当前版本、发布时间、文件大小和更新日志，并 SHALL 提供“立即更新”与“稍后”操作。

#### Scenario: User chooses later
- **WHEN** 用户在更新提示中选择“稍后”
- **THEN** 弹窗关闭且当前 App 会话不再自动重复提示

#### Scenario: App is restarted after dismissal
- **WHEN** 用户曾选择“稍后”但之后冷启动 App 且仍有新版
- **THEN** 系统再次展示更新提示

#### Scenario: Download cannot be opened
- **WHEN** 系统浏览器打开 APK 下载地址失败
- **THEN** 弹窗在操作位置附近展示可重试错误且 App 继续可用

### Requirement: APK download uses the system browser
客户端 MUST 仅允许通过系统浏览器打开知萃 HTTPS 下载目录中的 APK 地址，并 MUST NOT 在业务数据库或 WebView 中保存 APK 文件。

#### Scenario: User updates now
- **WHEN** 用户点击“立即更新”且下载地址通过安全校验
- **THEN** 客户端通过系统浏览器打开最新版 APK 下载地址

#### Scenario: Manifest supplies an untrusted URL
- **WHEN** 清单下载地址不是 HTTPS 或不属于允许的知萃下载目录
- **THEN** 客户端拒绝打开该地址并展示安全错误

### Requirement: Settings exposes manual update checks and release notes
Android 设置页 SHALL 显示当前安装版本，并允许用户主动检查最新版本、查看更新日志和下载新版；网页设置页 SHALL 清楚标识当前为 Web 版而不伪造原生版本。

#### Scenario: Android user manually checks
- **WHEN** Android 用户在设置页点击“检查更新”
- **THEN** 页面展示“已是最新版”、新版信息或可重试错误之一

#### Scenario: User dismissed automatic prompt
- **WHEN** 用户稍后进入设置页主动检查且线上仍有新版
- **THEN** 页面仍展示最新版本和更新日志并允许立即更新

### Requirement: Release metadata drives native versioning
Android 构建 SHALL 使用版本清单中的版本名与整数构建号生成原生 `versionName` 和 `versionCode`，发布脚本 SHALL 在生成 APK 前校验清单并将清单与 APK 一起提交。

#### Scenario: Release metadata is consistent
- **WHEN** 发布脚本构建 Android APK
- **THEN** APK 原生版本与线上版本清单一致

#### Scenario: Release metadata is incomplete
- **WHEN** 版本清单缺少版本号、构建号、下载地址或更新日志
- **THEN** 发布脚本在 Gradle 构建和 Git 推送前失败
