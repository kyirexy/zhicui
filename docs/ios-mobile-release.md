# iPhone 移动端发布

## 当前边界

- `frontend/ios` 是 Capacitor iOS 工程，不是 Electron Mac 客户端。
- 原生 API 使用 `https://luxai.cn`；本地 WebView 来源 `capacitor://localhost` 已纳入固定跨域来源。
- 最低 iOS 15.5；扫码插件依赖 CocoaPods，不能换成默认 SPM 后忽略 ML Kit。
- 官网在没有可验证安装渠道前显示“暂未开放下载”。模拟器 ZIP 不得复制到 iPhone 下载入口。

## Windows 上准备 / Mac 上编译

在 frontend 运行 `npm ci`，再执行 `npm run ios:build:prod`。Windows 可以生成静态资源和工程，缺 Xcode/CocoaPods 时会明确跳过原生编译。

云端使用 `.github/workflows/build-ios-mobile.yml`：安装依赖、构建生产静态资源、CocoaPods 同步、Xcode 模拟器无签名编译，随后启动模拟器、安装 App、验证运行并保存截图。产物仅为模拟器 App，保留 14 天。CI 不上传 App Store，也不提供无签名 IPA。

2026-09-06 最新验证：[运行 34027535273](https://github.com/kyirexy/zhicui/actions/runs/34027535273)，提交 `cef7294b5e409f36e93056bf59e4ddb1fc59ce27`。长图与个人数据导出使用系统保存/分享面板；iPhone 前后台恢复账号绑定状态，新增文件时间戳用途隐私清单。保存/分享插件与隐私清单已核对包含在实际模拟器 App 内。真机相机与系统分享目标仍按下方清单验收。

## 真机 / TestFlight 放行（需要账号持有人）

1. 注册 Apple Developer 并完成协议；在 App Store Connect 创建应用。确认 Bundle ID `com.videocapsule.app` 可注册，否则同步修改 Capacitor 和 Xcode 工程。
2. 在可信 Mac / 受控 CI 配置开发团队、Apple Distribution 证书、对应 App Store provisioning profile。私钥仅存 CI Secrets/钥匙串，不发到聊天、不提交 Git。
3. 使用 Xcode 的 `App.xcworkspace`，选择团队，Archive 真机 Release，执行 Validate App 和 Distribute App → App Store Connect。
4. 完成隐私清单、ML Kit 数据披露、相机用途、账号删除/隐私政策检查；根据实际模型与内容服务核对 App Store 审核要求。
5. 真机验证登录/退出、手机扫电脑码、图片/视频、相机拒绝后重试、前后台、旋转、安全区和键盘；未验收前不能标为正式版。
6. TestFlight 审核和公开邀请可用后，将官网下载状态改为真实 TestFlight HTTPS 链接；App Store 发布后改为真实商店地址。

苹果签名不是 Web 部署的一部分。官网更新可以独立走 Gitee/Jenkins，但安装包中静态 Web 资源变更仍需重新构建与分发，不能承诺 iOS 正式包无限制热更新。
