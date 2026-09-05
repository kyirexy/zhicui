## Why

用户需要 iPhone 移动客户端，而非将 Mac 桌面安装包当作手机版。官网必须在手机上清楚展示适用的下载入口，并真实标注尚未开放的分发渠道。

## What Changes

- 接入 Capacitor iOS 工程及云端 Mac 编译，复用移动首页、登录与扫码功能。
- 将共享原生移动端识别扩展到 iOS，保留 Android 专属插件和 APK 更新保护。
- 手机官网优先展示移动下载；新增独立 iPhone 入口，未签名分发前不提供虚假 IPA 下载。
- 验证后发布官网到正式环境；iOS 真机分发由苹果开发者签名与 TestFlight/App Store 凭据放行。

## Capabilities

### New Capabilities
- `ios-mobile-distribution`: iOS 壳、移动身份识别和真实分发边界。
- `mobile-official-download`: 响应式官网移动客户端下载入口。

### Modified Capabilities

无。

## Impact

frontend 原生识别、共享壳、登录扫码、官网组件、Capacitor 依赖及 iOS 工程；GitHub Mac CI；不改动现有账号数据和 Android 专属采集插件。
