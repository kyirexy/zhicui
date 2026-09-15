# Windows 1.1.10 / 网页 1.1.14 更新记录

Windows Beta 1.1.10 从提交 `7d8b777f0ef96359af7b2706d18f02991d0963b7` 的干净独立工作树构建，内置 CLI 1.0.2，更新通道 beta、`nativeUpdatesEnabled=false`。没有 Windows 发布者签名，本次不宣称安全自动安装能力；签名 Stable 发布仍须通过已有证书、时间戳、真实升级回滚与公网验收门禁。

本轮修复官网旧版本兜底、可变下载地址、版本文件覆盖和原生更新状态竞争，新增严格文件/签名确认及静默重启路径。更新卡片按实际状态显示下一步，网页更新提醒不阻挡使用。NSIS 安装界面已改为知萃品牌的中文首屏、同页安装位置和完成页，保留官方覆盖安装与资料保留流程。

## 构建与发布证据

- 安装包 `Zhicui-Setup-1.1.10-x64.exe`：93,663,809 字节。
- SHA256：`c1c0ee8f132d6e8bad279101b598b1ddaf1d48aef9586e372f20ecd276dcb5e5`。
- SHA512：`A4X16iinAjmkIfBsvbK0ttqPsMw3WFlx78cM2TnsSOZq9/uevt4WkNnWMp7NsZiuKSxD/EVK7HYZBqoGAH/J9A==`。
- 缓存/provenance 位于本机 `C:/Users/MAR/AppData/Local/Zhicui/release-cache/windows/7d8b777f0ef96359af7b2706d18f02991d0963b7/beta/1.1.10`。
- 已使用同一提交、同一缓存执行 `-SkipBuild -Publish`，服务器 payload 校验成功，未重建或覆盖其他版本，Stable 清单未更改。
- 本地完整前端构建通过，41 个页面生成；43 项前端更新相关用例、39 项原生更新/文件/Agent用例、32 项下载与发行用例通过。
- 更新页面独立视觉复核五项通过；NSIS 仅编译和代码审查，未在用户现有安装上执行安装、升级、回滚或原生窗口视觉验收。

公网完整安装包回读使用可断点校验的 2 MiB Range 请求；每次请求有超时与有限重试，按 Content-Range 和实际字节数核对后再计算整个文件哈希。本文提交时回读及网页正式部署验证仍在进行，以后续验收记录为准。

原始脱敏证据位于 `D:/6month/.codex-artifacts/desktop-update-ux-20260914/`。
