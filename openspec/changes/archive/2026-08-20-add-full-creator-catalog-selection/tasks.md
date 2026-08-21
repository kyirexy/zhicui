## 1. 持久数据与兼容迁移

- [x] 1.1 扩展 CreatorSourceItem 与 CreatorSyncRun 安全字段，并新增 CreatorSyncRunItem、约束、索引和脱敏序列化
- [x] 1.2 增加 SQLite/PostgreSQL 可重复 additive 启动迁移，保留旧 requested_limit 约束和旧运行兼容

## 2. 运行服务与 API

- [x] 2.1 实现 recent_transcript、catalog_all、selected_transcript 请求归一化和每用户单活动任务
- [x] 2.2 实现全量目录幂等写入、完整扫描不可用标记、墓碑保护、准确计数和服务端分页搜索筛选
- [x] 2.3 实现逐条文稿状态、最多 50 条校验、多 P 聚合、运行明细和失败项重试
- [x] 2.4 实现周期租约认领/续租、重启恢复、30秒/2分钟/10分钟有限退避、needs_action 和取消透传
- [x] 2.5 扩展 Creator Source API 与运行响应，保持旧 `{limit}` 请求及旧字段兼容

## 3. 平台连接器与部署

- [x] 3.1 扩展并固定现有抖音 sidecar 的 metadata-only 全量分页、进度、取消和浏览器回退协议
- [x] 3.2 增加固定 yutto 2.2.0 的 loopback 客户端/sidecar、resolve 流式枚举、取消和安全字段适配
- [x] 3.3 增加 yutto 独立 systemd、0600 token、健康检查、GPL-3.0 许可证与源码说明并保持默认关闭

## 4. 博主目录前端

- [x] 4.1 扩展前端类型、API 和 CreatorSyncContext，提供操作、来源快照、发现/处理计数、needs_action、目录与运行明细
- [x] 4.2 实现 `/library/creators` 来源管理、近期快捷提取、全量刷新、分页搜索筛选和最多 50 条选择
- [x] 4.3 从现有视频资料库增加博主入口，保持视频导航激活并使用稳定原生 dialog 完成确认/任务详情
- [x] 4.4 移除 AgentSourceSyncSheet 的重复长轮询并完善全局任务取消、重试、跨路由恢复、移动 safe-area 与无障碍反馈

## 5. 验证与发布门控

- [x] 5.1 扩展后端 unittest 覆盖兼容、隔离、分页、千条目录、重复刷新、墓碑、选择上限、部分失败、恢复、租约和敏感字段
- [x] 5.2 增加假 sidecar 契约测试覆盖抖音分页/验证码/取消及 yutto 流式/部分失败/多 P/不下载媒体
- [x] 5.3 运行目标后端测试和 Next.js production build，并完成 React 19、移动端及 DOM ownership 静态回归检查
- [x] 5.4 更新部署说明和功能开关流程，记录健康检查后抖音/B站小账号与多作品账号冒烟步骤
