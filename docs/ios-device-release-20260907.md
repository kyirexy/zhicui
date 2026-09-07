# iPhone 真机归档验证 · 2026-09-07

- 源码：`e40fdd0e459c37b31d1d6ddfa7f95297ca3c7170`。
- 云端记录：https://github.com/kyirexy/zhicui/actions/runs/34073377303 ，全部步骤成功。
- 实际产物：iPhoneOS ARM64 Release，版本 1.1.10，构建号 6，Bundle ID `com.videocapsule.app`。
- ZIP：21,324,599 字节；SHA256 `24289a752df5269ea24dc14b1b4b3d0549786b503aabec368da72b7112c30f2a`。已下载核对 ZIP CRC 和实际 Info.plist。
- 主程序 SHA256：`124cbf298079ee117bc68b6055113a70f4056dacd9754ace46c4065c87bc6f4b`。
- 通过隐私清单、文件保存/分享动态框架与主程序静态扫码类检查。扫码 Pod 为 static_framework，检查主程序中的 Objective-C 类记录，不要求独立嵌入框架。
- 本地相关检查共 17 项通过（发布配置 3、归档检查器 4、iOS 行为 6、文件导出 4）；云端重复通过并完成 Next 静态构建与 Xcode archive。
- 初次运行 34073200278 的 Xcode 归档成功，但检查器误按动态框架查找扫码插件，导致任务失败；修正后上述第二次运行通过。

这是未签名开发归档，不能直接安装到用户 iPhone。没有向官网发布虚假安装链接。后续签名导出入口已实现，尚缺苹果签名凭据验证，以及真机安装、相机、系统分享等验收。运行命令与分发说明见 `ios-mobile-release.md`。
