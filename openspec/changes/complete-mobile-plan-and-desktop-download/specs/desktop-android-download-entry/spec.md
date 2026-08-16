## ADDED Requirements

### Requirement: Windows 桌面侧栏提供 Android 下载入口

Windows 桌面客户端 SHALL 在侧栏左下的应用支持区域提供持久可见的 Android 下载操作，并 SHALL 将用户直接带到知萃公开 APK 下载地址。

#### Scenario: 桌面用户获取移动端

- **WHEN** 用户在 Windows 桌面客户端点击“下载移动端”
- **THEN** 客户端请求 `/download/zhicui.apk`
- **AND** 操作显示 Android 语义和当前用途，不与设置或退出账号混淆

#### Scenario: 用户使用紧凑侧栏密度

- **WHEN** 桌面端启用紧凑密度
- **THEN** 下载入口仍保持可读标签和至少 40px 的点击高度
- **AND** 入口位于账号区域上方且不会挤出可视窗口
