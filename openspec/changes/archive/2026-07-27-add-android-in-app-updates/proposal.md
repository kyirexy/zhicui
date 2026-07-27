## Why

当前 Android 安装包没有版本发现机制，用户安装后无法知道线上已经发布新版本，也看不到本次更新包含什么。需要建立一个不依赖登录状态的应用内更新流程，让每次 APK 发布都能被旧版客户端发现并安全跳转到最新版下载。

## What Changes

- 新增公开的 Android 最新版本清单，包含版本名、构建号、发布时间、下载地址和中文更新日志。
- Android App 启动后读取原生安装版本并检查线上清单；仅当线上构建号更高时展示更新提示。
- 更新提示展示新版本、更新日志、文件大小，并提供“立即更新”和“稍后”操作。
- 设置页展示当前安装版本、最近一次检查结果，并允许用户主动检查更新和查看更新日志。
- 使用系统浏览器打开 HTTPS APK 下载地址，避免在 WebView 内保存视频或安装包。
- APK 发布脚本在构建前校验版本清单与 Android 原生版本一致，构建后继续沿用 Gitee/Jenkins 正式发布链路。
- 网页端不自动弹出 Android 更新提示。

## Capabilities

### New Capabilities

- `mobile-app-updates`: Android 原生客户端的版本发现、更新提示、更新日志、下载跳转与发布一致性约束。

### Modified Capabilities

无。

## Impact

- 前端：根布局新增 Android 更新检查器，设置页新增版本入口，新增版本比较与线上清单读取逻辑。
- 后端：新增无需登录、禁用缓存的最新 Android 版本接口，读取同一份静态发布清单。
- Android：引入 Capacitor App 与 Browser 插件，递增 `versionCode`/`versionName`。
- 发布资源：新增 `/download/latest.json`，APK 构建脚本校验版本元数据。
- 部署：最终提交同时同步远程 `main`；现有 Jenkins 仍由 `master` 触发正式部署。
