## Context

Windows 客户端使用 electron-builder 26 的 NSIS assisted installer。当前 `createDesktopShortcut: true` 只保证首次安装时创建快捷方式；若旧版本安装时未创建、快捷方式曾被删除，覆盖安装不会强制补回。开发端和正式端还共用“知萃”窗口标题，虽然 IPC 已返回 `app.isPackaged`，但界面没有利用该信息显示构建身份。

## Goals / Non-Goals

**Goals:**

- 新装和覆盖安装均可靠创建“知萃”桌面快捷方式，并保留开始菜单入口。
- 开发版在窗口标题和应用页面中明确显示“开发版 · 本地调试”。
- 正式安装版不显示任何开发标识，产品名和快捷方式仍为“知萃”。
- 发布前自动校验安装器配置、运行身份契约和版本产物。

**Non-Goals:**

- 不改为全用户安装，不要求管理员权限。
- 不更换 NSIS/electron-builder，也不改变自动更新 feed 协议。
- 本次不解决 Windows 代码签名证书采购。

## Decisions

1. 将 electron-builder 的 `createDesktopShortcut` 从布尔值改为官方支持的 `"always"`。该选项专门用于在重新安装或覆盖升级时重建快捷方式，比自定义 NSIS 宏更少侵入，也能继续复用 electron-builder 的安装/卸载清理逻辑。
2. 继续使用 `createStartMenuShortcut: true` 和固定 `shortcutName: "知萃"`；正式版入口名称保持稳定，不把版本号写进快捷方式。
3. 以 `app.isPackaged` 作为唯一构建身份来源，并通过现有可信 preload IPC 返回 `channel` 与 `displayName`。开发版窗口标题和稳定挂载的页面徽标使用同一身份；正式包为 `stable`，不渲染徽标。
4. 增加无副作用验证脚本，读取 builder 配置和构建身份逻辑，避免未来回归；正式发布仍通过现有 `release-desktop.ps1` 校验版本、哈希和更新清单。

## Risks / Trade-offs

- [用户主动删除快捷方式后覆盖升级会重新出现] → 这是本次为“始终可找到应用”选择的明确行为；卸载仍由 NSIS 清理。
- [开发徽标遮挡业务 UI] → 放在桌面标题栏安全区，禁用指针事件并保持紧凑；仅未打包 Electron 渲染。
- [只校验配置不能完全替代每台 Windows 的安装测试] → 构建后同时检查 NSIS 产物、PE 版本和更新 feed；发布前保留一次全新安装冒烟测试。

## Migration Plan

1. 发布 `1.0.6` Windows 安装包，使现有用户通过覆盖安装/自动更新补回快捷方式。
2. 原子更新版本化安装包、blockmap、`latest.yml`、最新别名和桌面发布元数据。
3. 若新版本出现问题，恢复上一份 `latest.yml` 和最新别名即可停止分发，已有 `1.0.5` 仍可运行。

## Open Questions

无。
