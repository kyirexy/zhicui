## ADDED Requirements

### Requirement: 手机官网提供真实适用下载
官网 SHALL 在窄屏首屏提供移动客户端入口，并区分 Android、iPhone、Windows 和 Mac。

#### Scenario: 安卓访问
- **WHEN** 安卓浏览器访问官网
- **THEN** 优先展示 Android 下载，点击走真实 APK 下载接口，主要操作无需扫码另一台设备。

#### Scenario: iPhone 尚未发布
- **WHEN** iPhone 用户访问且没有正式分发地址
- **THEN** 展示独立 iPhone 发布状态，不把 APK、DMG 或无签名 IPA 当作其安装包。

#### Scenario: 窄屏布局
- **WHEN** 官网宽度为 320 至 430 像素
- **THEN** 下载操作可点击、内容无水平溢出、手机无需查找桌面版按钮才能发现移动版。
