## Context

知萃现有导入链在同步或粘贴链接后完成元数据解析、字幕/ASR 和普通摘要，视频 Agent 主要从文稿检索证据。现有批量任务存于进程内存，LLM 用量日志仅供观测，既不能承载高成本视觉任务的重启恢复，也不能作为资金账本。项目使用 FastAPI、SQLAlchemy、SQLite/PostgreSQL 和 Next.js 16 客户端组件，数据库迁移由启动时的增量迁移完成。

本变更需要同时约束三个边界：详细解析只能被显式触发；供应商技术能力与用户购买方案必须解耦；用户萃点与平台上游成本必须分别核算。首版在单进程部署中以数据库持久化任务和受控后台线程执行，保留迁移到独立队列 worker 的接口。

## Goals / Non-Goals

**Goals:**

- 支持用户单条、批量或交互式 Agent 按需解析视频画面，且普通同步、转写、摘要及自动化保持零视觉调用。
- 以 PySceneDetect 可靠采样场景，用本地结构结果或图片 VLM 生成带服务端时间码的视觉证据。
- 提供可版本化的 Provider/Offering 目录、独立视觉 BYOK、免费额度和统一萃点结算。
- 对报价、确认、任务、逐项结果和账务进行持久化，支持幂等、重启恢复、部分成功和失败释放。
- 在现有详情、批量、Agent、AppHeader 和管理页面内渐进呈现，不增加永久导航或内容 Tab。

**Non-Goals:**

- 首版不接微信/支付宝等在线支付，不区分赠送与购买萃点，不实现过期余额。
- 首版不交付具体原生视频模型驱动；没有已测试驱动时不允许发布专业 Offering。
- 不保存视频二进制、关键帧文件、base64、Cookie 或临时签名地址，不提供关键帧画廊。
- 不把 PySceneDetect 宣传为语义视觉模型，也不让 BYOK 成为独立解析算法。
- 不自动回填历史视频，不允许定时 Agent 或后台自动化产生新视觉费用。

## Decisions

### 1. 技术 Provider 与用户 Offering 分离

`VisionProvider` 描述驱动、凭证、能力、限制、健康和上游预算；`VideoAnalysisOffering` 描述可见名称、解析方法、触发渠道、限额、免费额度、萃点公式和不可变发布版本。这样管理员可以在不改变用户商品含义的情况下替换技术供应商，也能为同一 Provider 发布多个价格版本。

备选方案是把模型和价格写入一个配置对象，但会混淆上游成本、用户权益和历史报价，无法稳定复算，因此不采用。

### 2. 账务使用账户快照加只追加账本

`UserAnalysisAccount` 保存可用与预留萃点的快速快照；`AnalysisCreditLedger` 只追加记录 grant、adjustment、reserve、capture、release、refund。所有资金变更和任务状态变更在一个数据库事务内完成，并通过唯一幂等键避免重复预留。

报价由服务端探测的真实时长、Offering 版本及最大帧/调用量生成，客户端只提交 quote/run 标识与幂等键。报价快照保存公式、上限、过期时间和每项明细；实际用量不超过授权上限，超过时进入重新授权状态。平台上游成本单独以整数微元记录，不从萃点推导。

SQLite 开发环境使用短事务和进程锁，PostgreSQL 使用行锁；不依赖现有 LLM 用量日志作为权威资金记录。

### 3. Run 与 Item 双层持久状态

`VideoAnalysisRun` 表示一次单条或批量请求，`VideoAnalysisItem` 表示逐 Note 执行与结算。运行状态与账务状态分离，允许批次部分成功。活动任务在启动时扫描：未执行任务重新排队，长期停滞且无法安全续跑的任务失败并释放预留。

第一版使用进程内受限 `ThreadPoolExecutor` 消费数据库任务，而不是沿用不可恢复的 `_JOBS`。数据库才是状态真相；后续可把同一 claim/execute 接口接到 Celery、RQ 或云队列。

### 4. 缓存键与结果归属

`VideoAnalysis` 以 `user_id + note_id + offering_version + source_fingerprint` 唯一缓存。指纹优先使用平台作品 ID、媒体版本和时长；无法取得版本时包含 Note 更新时间。缓存命中不消耗免费额度、不预留萃点，并直接关联到新 Run Item。

结构化结果保存章节、场景、画面观察、OCR 文本、人物、物体、动作、事件、证据时间码、质量与降级原因。媒体和帧只存在于任务级临时目录，并在 `finally` 中清理。

### 5. PySceneDetect 是采样层

`local_scene` 使用 `AdaptiveDetector(adaptive_threshold=3.5, min_scene_len=0.6s, window_width=3, min_content_val=15)` 生成镜头边界、章节和均匀代表帧；检测失败时均匀抽帧。免费基础最多 8 帧，`scene_frames_vlm` 按时长在 8–24 帧自适应，每次图片 VLM 最多 8 帧，长镜头每 10 秒补帧。

`scene_frames_vlm` 通过驱动接口提交压缩后的内存图片并要求严格 JSON；输出必须由服务端附加 `timestamp_ms`。视觉失败仍保留本地场景结构和原文摘要，状态为 partial。`native_video` 只有抽象驱动和能力校验，首版无实现。

### 6. 摘要回写使用命名字段合并

详细结果写入现有 `ai_summary` 的 `detailed_video_analysis` 命名字段并保留未知字段，不替换普通摘要。Agent 检索可读取该结构，但用户界面仍在现有摘要区域呈现，不新增 Tab。重复分析生成新结果并切换当前引用，旧结果保留用于报价与审计。

### 7. BYOK 独立且失败关闭

`UserVisionProviderConfig` 与文字 LLM 配置完全分离，凭证继续使用 Fernet 加密。用户只能选择管理员声明为支持 BYOK 的驱动/能力，测试请求必须使用真实小图片。BYOK 不扣平台模型费用，但仍可按 Offering 规则收取本地处理费；失败时绝不静默切到平台收费 Key。

### 8. 渐进授权交互

Catalog 只返回已发布、当前可用且总开关开启的 Offering。单条点击先原位展示推荐方案；缓存或免费单条可直接开始，付费、BYOK 或多条必须展示服务端报价 Sheet。确认后 Sheet 立即关闭，页面通过 active-run API 恢复状态，AppHeader 只在有活动任务时出现临时入口。

Agent 工具 schema 仅允许来源快照中的 `note_ids`。服务端先检查缓存和 Offering：单条零萃点可自动开始，其余返回 `approval_required` 终态并关闭 SSE。确认接口绑定 Note、Offering 版本、帧/调用限制和萃点上限；完成后创建恢复任务继续原问题。自动化执行上下文硬性拒绝创建视觉 Run。

### 9. 安全与观测

API、SSE、审计与账本只返回 Provider 标签、用量和安全错误码，不返回 Key、Cookie、媒体 URL、base64 或本机路径。Provider 只能停用而不物理删除。管理员测试成功是发布 Offering 的前置条件；成本未知的 Provider 不能发布收费 Offering。全局和 Provider 并发、每日预算、超时及熔断均在发起上游调用前检查。

## Risks / Trade-offs

- [单进程后台线程不具备分布式吞吐] → 数据库任务设计为可认领和可恢复，首版限制全局并发 1，未来平滑迁移队列 worker。
- [SQLite 缺少完善的并发行锁] → 使用短事务、唯一约束和进程锁保证开发环境幂等；生产 PostgreSQL 使用 `FOR UPDATE`。
- [视频签名 URL 会过期] → 执行时重新从平台/Note 元数据解析，不把临时地址写入任务或日志。
- [免费视觉供应商不稳定] → 免费 Offering 明确允许降级为 `local_scene`，结果记录降级原因且仍为 0 萃点。
- [模型输出或 OCR 可能误判] → 所有视觉证据标为“AI 画面观察”、携带时间码与置信度，不冒充逐字原文。
- [上游已产生的 BYOK 费用无法退款] → 确认 Sheet 明示责任边界，失败只释放知萃侧预留。
- [价格或成本配置错误造成亏损] → 发布版本不可变、收费 Provider 必须有已知成本与测试状态，并支持 Provider 日预算熔断。

## Migration Plan

1. 部署新增表、依赖和默认关闭的系统设置；启动恢复器只处理本功能新表。
2. 管理员配置并测试本地免费 Provider，创建但暂不发布 Offering；发放测试萃点验证账务。
3. 发布免费基础 Offering，灰度验证单条、批量、清理和恢复；再配置平台图片 VLM 和视觉 BYOK。
4. 验证成本与毛利后发布标准收费 Offering；原生视频 Offering 保持隐藏，直到驱动实现并通过测试。
5. 回滚时关闭总开关并停用 Offering，允许活动任务完成或取消并释放预留；保留结果和只追加账本，不删除历史表。

## Open Questions

- 首个生产图片 VLM 的供应商、媒体计量字段和微元成本表由运营配置决定，不在代码中硬编码。
- 当部署扩展为多 worker 时，需选择独立任务队列；当前数据库 claim 协议保持兼容。
