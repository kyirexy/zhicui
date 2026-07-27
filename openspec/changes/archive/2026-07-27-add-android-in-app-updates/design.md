## Context

知萃 Android 客户端由 Next.js 静态导出后通过 Capacitor 打包，正式 APK 固定下载地址为 `https://luxai.cn/download/zhicui.apk`。当前 Android `versionCode` 为 1，客户端没有读取原生安装版本或检查线上版本的能力。更新检查必须在未登录状态也能工作，不能依赖用户表或管理端配置，并且不能让网页访客反复看到 Android 弹窗。

## Goals / Non-Goals

**Goals:**

- Android 冷启动时自动发现更高的线上构建号。
- 在清晰、非强制的原生端弹窗中展示版本信息和中文更新日志。
- 用户可以稍后处理，也可以从设置页再次主动检查。
- 下载必须交给系统浏览器，并限定到知萃 HTTPS 下载地址。
- 发布清单、Android 原生版本和 APK 构建保持一致。

**Non-Goals:**

- 不实现 Google Play 或其他应用商店内更新。
- 不在后台静默下载或自动安装 APK。
- 不强制用户更新，也不阻止继续使用旧版本。
- 不向网页端展示自动更新弹窗。
- 不把 APK 二进制或更新状态写入业务数据库。

## Decisions

### 使用静态线上版本清单

新增 `frontend/public/download/latest.json` 作为唯一线上版本清单。后端通过无需登录的 `/api/app/releases/latest` 读取并校验同一文件，返回 `no-store` 响应；Android 客户端通过正式 API 域名请求该接口，并追加时间戳、使用 `cache: no-store` 避免 CDN 或 WebView 缓存旧版本。静态清单仍可从 `https://luxai.cn/download/latest.json` 直接查看。

相比新增数据库表或后台配置，静态清单不需要认证、数据库迁移或管理端权限；公开 API 复用现有 Capacitor CORS 通道，避免 WebView 直接跨域读取 Next.js 静态文件。清单与 APK 一起由现有 Jenkins 发布，故障面更小。

### 使用原生构建号做更新判断

引入 Capacitor App 插件读取 `App.getInfo()`，以整数 `build` 和清单 `build` 比较。版本名仅用于展示，避免语义化版本字符串比较的歧义。网页环境和非 Android 原生环境直接跳过自动检查。

### 通过系统浏览器下载

引入 Capacitor Browser 插件打开经校验的 `https://luxai.cn/download/` 地址。客户端不在 WebView、数据库或应用私有目录中保存 APK，也不尝试绕过 Android 的“未知来源应用”安装确认。

### 使用原生 dialog 与会话级稍后提醒

沿用项目现有 `<dialog>.showModal()` 交互原语。更新并非破坏性操作，弹窗提供“稍后”和“立即更新”。用户选择稍后后，仅在当前 App 会话内不再自动弹出；下次冷启动仍会提醒。设置页始终可以重新检查。

### 版本清单驱动 Android 构建

Gradle 在构建时读取 `latest.json` 的 `version` 和 `build`，作为 `versionName` 和 `versionCode`，避免重复维护两套版本号。构建脚本在构建前校验清单字段、HTTPS 下载域名和更新日志，并在提交 APK 时同时暂存清单。

## Risks / Trade-offs

- [线上清单暂时不可用] → 静默保留当前版本，设置页展示可重试错误，不影响主业务。
- [浏览器缓存旧清单] → 请求使用时间戳查询参数和 `no-store`。
- [错误清单导致错误提示] → 客户端做结构校验，Gradle 和构建脚本在发布前再次校验。
- [用户需要允许安装未知来源 APK] → 交给系统浏览器与 Android 安装确认，不绕过系统安全策略。
- [固定域名未来迁移] → 下载地址集中在清单与校验函数，后续可显式扩充允许域名。

## Migration Plan

1. 发布版本清单与更新检查代码，Android 版本升级到 `1.1.0 (2)`。
2. 构建并替换正式 APK，再由 Gitee `master` 触发 Jenkins 同步网页资源。
3. 将同一最终提交推送到 GitHub/Gitee `main`，同时保留 `master` 为现有部署分支。
4. 验证旧版构建号 1 对线上构建号 2 会显示更新，新版构建号 2 不会误报。
5. 回滚时可恢复上一提交；旧 App 遇到清单不可用时不会阻断使用。

## Open Questions

无。
