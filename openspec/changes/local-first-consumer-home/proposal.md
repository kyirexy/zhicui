## Why

当前桌面首页用四个统计数字强调“云端工作概览”，更像管理后台，也让用户在进入产品时先理解数据口径而不是继续自己的视频、知识和计划。首页读取完全依赖网络，用户也无法决定近期工作数据是否在当前设备保留。

## What Changes

- 移除首页“工作概览 / 最近一次云端数据”及四项统计卡片，改为以“继续整理”和“今天要做”为核心的个人入口。
- 首页默认在当前设备保存一份轻量工作区快照，启动时先显示本地内容，再静默刷新账号数据。
- 设置页新增“本地数据”设置，用户可关闭本地快照、清除已保存内容，并看懂本地数据与账号同步数据的边界。
- Windows 桌面端继续提供独立的视频文件本地保存目录与自动保存设置；结构化数据快照不包含视频文件和完整文案正文。
- 本地快照按用户隔离，退出或切换账号时不会读取其他用户的内容。

## Capabilities

### New Capabilities

- `local-first-workspace-cache`: 定义用户可控、按账号隔离的近期工作区本地快照、启动恢复和清除行为。

### Modified Capabilities

- `douyin-library-homepage`: 桌面登录首页从数据看板改为面向个人使用的继续整理与今日行动界面。

## Impact

- `frontend/src/components/DesktopWorkspaceHome.tsx`：移除统计条并增加本地快照优先恢复。
- `frontend/src/app/settings/page.tsx` 与设置组件：新增本地数据开关、说明和清除操作。
- `frontend/src/lib/hooks/SettingsContext.tsx`、`frontend/src/lib/types.ts`：新增设备级本地数据偏好。
- 浏览器存储：新增按用户命名的轻量工作区快照；不引入新依赖，不改变后端 API 或数据库结构。
