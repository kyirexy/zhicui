## Why

当前 Windows 安装器虽然声明创建桌面快捷方式，但缺少针对实际 NSIS 产物的发布验证，用户安装后可能找不到入口；同时本地开发窗口与正式安装版缺少明确身份差异，容易误把开发进程当成已安装正式版。

## What Changes

- 强化 Windows NSIS 安装行为，确保全新安装及覆盖升级后存在可用的桌面快捷方式和开始菜单快捷方式。
- 为开发模式提供明确、非侵入式的“开发版”窗口身份；正式安装包不显示开发标识。
- 增加构建/发布验证，检查安装器配置、应用版本、开发/正式身份策略及快捷方式目标。
- 发布新的 Windows 修复版本，并保持现有 HTTPS 自动更新 feed 兼容。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `client-update-delivery`: 补充 Windows 安装后快捷方式可用性、开发与正式版本身份区分及发布校验要求。

## Impact

- `desktop/package.json` 的 electron-builder/NSIS 配置与 Windows 安装产物。
- `desktop/src/main.ts` 的窗口标题及运行环境身份。
- 桌面端验证、发布脚本和 Windows 更新 feed 产物。
- `openspec/specs/client-update-delivery/spec.md` 的安装与身份要求。
