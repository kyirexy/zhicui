## MODIFIED Requirements

### Requirement: Settings exposes manual update checks and release notes

Android 设置页 SHALL 显示当前安装版本，并允许用户主动检查最新版本、查看更新日志和下载新版；Windows 桌面端 SHALL 显示当前桌面版本、下载状态与可用安装操作；普通网页设置页 SHALL 清楚标识当前为 Web 版，并提供 Android 与 Windows 客户端的可信下载入口而不伪造原生版本。

#### Scenario: Android user manually checks
- **WHEN** Android 用户在设置页点击“检查更新”
- **THEN** 页面展示“已是最新版”、新版信息或可重试错误之一

#### Scenario: Desktop user manually checks
- **WHEN** Windows 桌面用户在设置页点击“检查更新”
- **THEN** 页面展示当前版本、检查/下载状态、可重试错误或“重启并安装”操作之一

#### Scenario: Web user views client downloads
- **WHEN** 普通网页用户打开设置页
- **THEN** 页面标识 Web 会自动使用线上最新版
- **AND** 同时提供 Android App 与 Windows 桌面端的清晰下载入口

#### Scenario: User dismissed automatic prompt
- **WHEN** 用户稍后进入设置页主动检查且线上仍有新版
- **THEN** 页面仍展示最新版本和更新日志并允许完成更新
