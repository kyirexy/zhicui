# 2026-09-05 发布记录

## 正式 Web 与后端

- 发布提交：`caf4f0fb92645ef9db669e0d6f4b3fea7f2f692f`；GitHub/Gitee master 同步。
- Jenkins `zhicui-deploy #182`：SUCCESS。Gitee 推送未自动入队，使用已有 GenericTrigger 配置补触发，未绕过部署门禁。
- runtime：`/opt/zhicui-runtime/releases/jenkins-zhicui-deploy-182`。
- 线上 build_id：`caf4f0fb9264-20260905135341`。
- 加密备份、隔离恢复、readiness、真实用户旅程均通过；历史 runtime 缓存清理存在权限警告，不影响发布。
- `/api/health` 为 ok，`/api/readiness` 为 ready；Agent 对外接口继续保持原有 dark 状态。
- iOS 来源 `capacitor://localhost` 登录预检 200，来源头准确回显；`capacitor://untrusted` 返回 400，无放宽任意来源。
- 官网 320/390 像素手机和 1440 像素桌面检查；最窄屏无横向溢出，手机主要下载按钮 64px，电脑次要入口仍可点击。
- 正式站 `/#download-ios` 已确认包含独立 iPhone 状态，未伪造 Apple 安装链接。
- 安卓统计下载接口 `/api/client-downloads/android` 返回 307，准确跳转 `/download/zhicui.apk`；APK 文件响应 200，大小 33,381,202 bytes。

## iOS 编译

- 云端工作流：https://github.com/kyirexy/zhicui/actions/runs/33969560350 ，SUCCESS。
- 与正式代码一致的提交 `caf4f0fb92645ef9db669e0d6f4b3fea7f2f692f`。
- Artifact：`zhicui-ios-simulator-caf4f0fb92645ef9db669e0d6f4b3fea7f2f692f`，14,280,875 bytes，保留 14 天。
- 解包检查：736 个 ZIP 条目、658 个 Web 资源条目、有 App Info.plist；没有 APK/DMG/EXE/IPA；Bundle ID 为 `com.videocapsule.app`；未开启 remote live reload。
- iOS、扫码、导航、客户端认证、Agent 接入相关 Node 回归与 TypeScript 检查通过；后端 iOS 来源/身份和隐私控制共 8 项通过。官网 Next 生产构建通过；设计检测无问题。

## 尚未放行

模拟器产物不能安装到 iPhone。仍需账号持有人完成 Apple Developer 配置、合法签名、真机验收、TestFlight/App Store 分发，之后才能开放官网 iPhone 下载。未归档变更，不声称已上线 iPhone 安装包。
