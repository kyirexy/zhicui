## Context

现有 Creator Sync 已有用户级来源、作品防重/墓碑、20/50/100 近期任务、全局轮询和重启恢复，但运行结果被限制在最多 100 条，连接器也只枚举近期作品。全量公开视频可能有数千条，发现总数在开始时未知，若沿用当前“发现即逐条转写”的执行方式，会放大 ASR 成本、任务时长、结果体积和故障恢复风险。

抖音生产已经通过隔离的 `jiji262/douyin-downloader` metadata-only sidecar 访问用户作用域会话；B站近期任务使用 yt-dlp flat playlist。全量 B站枚举需要一个不会下载媒体、可流式返回作品的连接器。前端为 Next.js 16/React 19 SPA，任务必须跨路由和刷新恢复，所有确认层必须遵守 React DOM ownership 约束。

## Goals / Non-Goals

**Goals:**

- 保持近期 20/50/100 条自动准备普通文稿的现有行为和旧 API 兼容性。
- 把“全部”实现为抖音/B站公开作品元数据目录，用户每次最多选择 50 条准备文稿。
- 对数千条目录进行幂等分页、搜索和状态筛选；完整扫描后才更新不可用状态。
- 让发现与处理任务可取消、可恢复、可有限重试，并把登录/验证码/风控转成明确的需用户处理状态。
- 不持久化 Cookie、签名媒体 URL、媒体路径、二进制或完整上游响应。

**Non-Goals:**

- 定时追更、多博主批量更新、私密/付费内容绕过、媒体归档和无限制并发。
- 全量目录自动 ASR、自动知识卡或行动计划。
- 小红书全量目录；小红书继续现有近期同步。
- 将 yutto 或上游抖音代码链接/复制进 FastAPI 进程。

## Decisions

1. **显式操作而非特殊 limit。** `operation` 取 `recent_transcript`、`catalog_all`、`selected_transcript`。旧 `{limit}` 在服务端归一化为近期任务。保留旧 `requested_limit` 的 20/50/100 数据库约束；新任务用 `target_count` 表达真实处理量，避免破坏已有数据库。
2. **目录和运行明细分离。** `CreatorSourceItem` 是完整目录的幂等真相，存安全元数据、最后发现任务、可用性和文稿映射。`CreatorSyncRunItem` 只保存近期/勾选文稿任务的逐条处理状态、重试和错误；全量刷新不复制数千条 run-item。
3. **阶段化持久任务。** `CreatorSyncRun` 保存操作、游标、发现完成标记、发现/处理/总数、来源快照、下一次重试和需用户处理原因。为兼容旧数据库状态约束，等待重试仍使用 `queued + next_retry_at`，需人工处理使用 `failed + needs_action`；worker 周期扫描到期租约并条件认领，处理中续租。瞬时错误采用 30 秒、2 分钟、10 分钟三次退避，认证/验证码/风控停止自动重试。
4. **完整扫描才使旧作品失效。** 扫描开始只更新本次看见的项目；只有连接器明确完成且无目录级失败时，才把该来源未在本次发现的非墓碑项目标记不可用。取消或部分失败保留旧目录状态。
5. **目录只保留安全字段。** 标准字段包括稳定作品 ID/规范 URL、标题、封面、简介、作者、发布时间、时长、顺序和多 P 的稳定标识/规范页面 URL。序列化前执行允许列表；禁止保存 Cookie、请求头、签名媒体 URL、临时下载 URL、路径和二进制。
6. **平台连接器隔离。** 抖音升级并固定现有 jiji sidecar，增加 metadata-only 全量游标/进度/取消，不引入第二套工具。B站近期保持 yt-dlp；全量使用固定 yutto 2.2.0 的 `resolve.start`/`item_listed`，由独立 loopback WebSocket sidecar 和 0600 token 隔离。FastAPI 只消费协议，部署保留 GPL-3.0 许可证与源码说明。
7. **BVID 是目录粒度。** 一条 BVID 对应一个 `CreatorSourceItem`，parts 只保留 `cid`、页码、标题和稳定页面 URL。勾选后按 P 顺序复用现有字幕→云 ASR→本地 ASR路径，最终合并为一份普通文稿和一条资料库记录。
8. **全局轮询是唯一任务真相。** `/library/creators` 和既有 Sheet 只消费 `CreatorSyncContext`，不创建组件级长轮询。任务详情与确认使用稳定挂载的原生 `<dialog>`。目录服务端游标分页默认 50，前端最多选择 50。

## Risks / Trade-offs

- [yutto server API 标记 Experimental] → 固定版本与提交、独立进程、契约测试、健康开关，并保留 yt-dlp 近期路径。
- [抖音验证码和登录状态不可预测] → 不自动绕过或死循环，保存脱敏 `needs_action` 并允许用户完成授权后重试。
- [SQLite 缺少 PostgreSQL 级行锁] → 用条件更新和租约 owner/到期时间保证尽力单认领；生产 PostgreSQL 负责并发强保证，开发 SQLite 只运行单 worker。
- [全量目录增加资料查询压力] → 复合索引、服务端搜索/筛选、游标分页和聚合运行摘要；不把全量结果塞入 `results_json`。
- [旧数据库无 Alembic] → 延续 `_migrate_db()` 的可重复 additive migration；先加可空/有默认值列和新表，保留旧约束与响应字段。

## Migration Plan

1. 在功能总开关关闭状态部署 additive 数据库迁移和 API，旧近期任务继续可读写。
2. 部署固定版本的抖音与 yutto sidecar；生成 root-only/服务用户 0600 token，限制回环监听，安装许可证和源码说明。
3. 管理员分别执行连接器健康测试，只对抖音和 B站开放 `catalog_all` 能力。
4. 用小账号和多作品账号验证目录完整性、取消、重复刷新、选择转写和多 P 合并，再开放前端入口。
5. 回滚时关闭全量 capability/sidecar；新增表列保留，近期同步仍按旧路径运行。

## Open Questions

- 无阻塞问题；sidecar 的具体提交哈希在部署脚本中固定，并由回归测试记录。
