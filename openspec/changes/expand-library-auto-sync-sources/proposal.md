## Why

自动同步仍固定为“最近 50 条抖音收藏”，与现有的抖音喜欢/作品及 B 站、小红书账号资料能力不一致；同时文案批次全部失败时只显示一条固定错误，用户无法判断资料是否已同步或为什么失败。

## What Changes

- 抖音自动同步依次覆盖收藏、喜欢和自己的作品，并合并去重需要准备文案的条目。
- 设置页明确区分可后台自动读取的抖音范围，以及需要用户在官方页面确认的 B 站、小红书收藏/喜欢范围。
- 文案准备失败项自动重试一次；仍失败时保留资料同步成功结果并记录为“部分完成”。
- 部分完成反馈展示失败数量与安全截断的真实原因，后续周期继续重试尚无文案的条目。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `douyin-library-sync-control`: 自动同步范围从单一收藏扩展到收藏、喜欢和作品，并增加部分完成与文案重试语义。
- `multi-platform-video-library-import`: 设置页明确 B 站、小红书账号同步仍需用户在本机官方页面确认，不能由后台定时器静默触发。

## Impact

- `frontend/src/lib/libraryAutoSync.ts`：多来源编排、去重、文案重试和部分完成状态。
- `frontend/src/components/AutoSyncSettingsCard.tsx`：同步范围和多渠道安全边界说明。
- 不新增后端接口，不上传 B 站或小红书本机会话，不改变数据库结构。
