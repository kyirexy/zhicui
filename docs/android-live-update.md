# Android 界面更新模式

Android 发行现在支持两种明确的 UI 模式：

- `bundled`：前端静态资源进入 APK，适合 Stable、离线场景和原生能力变更。
- `remote`：APK 保留原生壳，Capacitor WebView 加载 `https://luxai.cn`，适合 Beta 的快速界面发布；后端与网页发布后无需重新安装 APK。

构建 Beta 远程 UI 版本时显式设置：

```bash
CAPACITOR_REMOTE_UI=1 RELEASE_CHANNEL=beta RELEASE_VERSION=1.3.8 RELEASE_BUILD=30 \
  RELEASE_COMMIT=<40 位提交 SHA> bash scripts/build-apk.sh
```

Stable 构建脚本会强制使用 `bundled`，不会把远程页面模式带入正式 APK。远程 UI 地址在 `frontend/capacitor.config.ts` 中只允许 `https://luxai.cn`，避免把构建产物指向任意外部站点。

无论哪种模式，Android APK 都使用版本化地址 `/download/android/Zhicui-<version>-<build>.apk`；`/download/zhicui.apk` 只为旧客户端保留兼容下载。
