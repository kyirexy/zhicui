## Context

现有 Android Capacitor 8.5.1 使用静态 Web 资源；共享组件误将原生移动端等同 Android。Mac 包属于桌面 Electron，不能安装到 iPhone。仓库目前没有 Apple 签名 Secrets。

## Goals / Non-Goals

**Goals:** 复用移动工作台接入 iOS；提供可重复的云端编译；官网手机访客能直接获取适用安装入口。

**Non-Goals:** 不绕过苹果签名，不扩大浏览器客户端权限，不声称已真机测试，不改动 Android 原生平台采集实现。

## Decisions

- 使用 Capacitor 官方 iOS 工程和 CocoaPods。现有 ML Kit 扫码插件不支持 SPM，不能直接采用默认 SPM 工程。
- 共享页面使用 isNativeMobileApp；Android 相册/启动抖音、APK 更新继续使用 Android 专属判断。认证策略新增 nativeMobile 兼容字段，不破坏已有调用。
- 原生 API 保持 https://luxai.cn，iOS 本地源为 capacitor://localhost。后端现有 allowlist 必须实测，不能扩大为任意来源。
- CI 在 Mac runner 构建无签名模拟器包；签名真机分发作为独立放行任务，缺凭据不自动购买或假装发布。
- 官网首屏手机入口优先，iPhone 仅显示准备中并链接真实说明；Mac 与 Windows 作为电脑版本保留。Android 使用现有统计下载重定向，不新建伪下载。

## Risks / Trade-offs

- [缺苹果账号] → 无法 TestFlight 发布，单独交付官网和工程并明确待办。
- [iOS 插件兼容] → CocoaPods、云端 Xcode 编译验证；真实相机和键盘待真机验收。
- [生产混入既有本地改动] → 基于当前正式 SHA 的独立索引仅提交范围内文件，Jenkins 原有回滚门禁保留。

## Migration Plan

先测试和云端编译，再通过 Gitee 触发正式部署并核对健康和网页。失败沿用不可变发布目录回滚。iOS 有签名并验收后才开放正式安装链接。

## Open Questions

待用户提供 Apple Developer 账号的合法签名配置和 TestFlight 应用信息；不在对话索取明文私钥。
