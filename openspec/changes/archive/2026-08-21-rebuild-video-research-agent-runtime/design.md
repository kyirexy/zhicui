## Context

知萃已有持久 `AgentThread`/`AgentMessage`、来源快照、同步与非同步消息接口、SSE 里程碑、证据校验和 Harness UI，但一次问答仍由 `answer_library_question` 单体函数完成。当前 `fast|deep` 由用户手选且默认 `fast`，跨视频问题可能只把召回的部分来源送入综合；验证器会过滤结构化 evidence，却无法删除正文中模型自行写出的失效“来源 N”；会话只把最近六条消息提供给模型。SSE 工作由请求线程启动，断线后缺少持久事件游标和明确的 Turn 恢复协议。

参考 DeepSeek Harness 的追加式会话事件、插件能力边界和压缩事务，以及 OpenAI Codex 的 Turn/Step、稳定上下文、工具结果限界和自动压缩模式。本设计只移植架构与小型通用算法，继续使用 Python/FastAPI/SQLAlchemy，不引入 Node/Rust 运行时。

## Goals / Non-Goals

**Goals:**

- 让单次提问成为可持久、可恢复、可取消、可幂等重试的 Agent Turn。
- 自动区分单视频事实问答与跨视频研究，并对所有选定来源给出真实覆盖计数。
- 用受限的视频领域能力完成分层扫描、聚类、Claim 综合、引用验证和有界修复。
- 让最终正文只引用验证通过的 Evidence，并为“反复观点”提供跨视频支持数量。
- 在长会话中保存用户目标、纠正、已验证观点和未决问题，同时控制上下文大小。
- 兼容现有 Thread/Message、SSE 与 Harness，支持灰度和安全回退。

**Non-Goals:**

- 不实现 Shell、文件编辑、浏览器控制、代码沙箱或通用编程 Agent。
- 首版不实现多 Agent/子 Agent 调度，不把 DeepSeek Harness 作为生产 sidecar。
- 不自动给普通视频问答启动付费视觉解析；仍沿用现有确认流程。
- 不把 Cookie、签名媒体 URL、媒体文件或完整请求密钥写入事件日志。

## Decisions

### 1. 在现有 Thread 下增加持久 Turn 与追加式 Event

新增 `AgentTurn` 作为一次用户提问的执行实体，记录请求/解析后的研究模式、阶段、尝试次数、幂等键、租约、取消、计数、错误和最终消息；新增 `AgentEvent`，用 `(turn_id, seq)` 唯一序号追加阶段与安全诊断。`AgentTurnSource` 记录冻结来源及 scanned/mapped/deep-read 状态，`AgentClaim`/`AgentEvidence` 保存候选与已验证观点，`AgentMemoryCheckpoint` 保存结构化长期记忆。

事件是后台恢复和 UI 进度的事实来源；Thread/Message 继续作为公开会话与最终回答模型。历史线程不批量回填，首个 V2 Turn 从旧消息派生初始记忆。

### 2. 使用轻量领域运行时，不建设通用插件框架

定义固定的 `AgentTool` 协议与注册表，首版工具为来源搜索、文稿片段读取、批量映射、主题聚类、逐字证据验证和成果保存。工具调用经过参数校验、取消/租约检查、结果大小限制、执行与结果落事件五个阶段；相同参数连续调用三次提示规划器，五次终止该路径。

相比直接接入 DeepSeek Harness，这一方案复用现有鉴权、数据隔离、计费、模型路由和部署；相比继续扩展单体函数，它提供可测试的能力边界。

### 3. 自动路由与分层多来源研究

公开请求支持 `research_mode=auto|fast|deep`，默认 `auto`。显式 fast/deep 始终优先；auto 综合来源数量、输出方式、确定性关键词与小型结构化分类结果。单视频/少量明确事实走 fast；六条及以上来源且属于共同主题、反复观点、整体总结、比较、趋势或行动归纳时走 deep。

Deep 研究先让全部冻结来源参加第一层结构化扫描；每批最多五条、并发最多三批。超过 100 条时仍扫描全部来源的标题、摘要和分块索引，再按相关性、代表性、分歧和新颖性选择最多 100 条进行 transcript map，最多 40 条深读原文。UI 分别显示范围、扫描、映射与深读数量，不得把扫描宣称为已读。100 条以内的 transcript-ready 来源全部完成 map，除非取消或明确部分失败。

### 4. Claim-first 生成与验证后渲染

研究结果先生成结构化 Claim：稳定 ID、观点、支持 note IDs、类型、支持数、置信度和候选 Evidence。Evidence 的 quote 必须逐字存在于冻结的 transcript/summary/visual 上下文中。服务端验证后，最多进行两轮修复；仍不合格的 Claim 被删除或标为不确定。最终 Markdown 从已验证 Claim 和普通非事实性过渡文字生成，模型不得自行引用“来源 N”。反复/共同观点至少需要两个独立 note 支持。

### 5. 有界上下文与长期记忆

Prompt 采用稳定有序分区：身份与边界、研究计划、来源清单、长期记忆、最近对话、工具契约、输出契约。上下文估算达到模型窗口 75% 时创建检查点，保留最近四个完整 Turn，并把更早内容折叠为结构化 JSON：用户目标、偏好、纠正、已验证 Claim IDs、未决问题和来源范围。检查点替换旧上下文视图而不重复注入，原始 Message/Event 不删除。

### 6. Durable worker、SSE 重放和幂等

消息提交携带 `client_turn_id`；同一 Thread 重复提交相同 ID 返回原 Turn，不新增消息或计费。后台 worker 每五秒认领 queued/due Turn，使用五分钟租约并每分钟续租；阻塞模型调用期间独立续租，丢失 lease token 的 worker 不得提交事件或最终答案。取消在工具边界和最终提交前生效，已验证中间结果保留。

现有 POST stream 保持可用并返回 `turn_id/seq`；新增 Turn 详情、游标事件列表、恢复 SSE、取消和重试接口。断线不取消后台 Turn，前端按 `after_seq` 重放后继续订阅。

### 7. 默认仅视频与灰度双轨

`web_scope` 缺省改为 `video_only`；用户显式选择自动联网时才调用现有安全网页研究。设置增加 V2 总开关、灰度百分比和用户白名单，按 user ID 稳定哈希分桶。未灰度用户继续 V1；V2 在尚未发布任何回答 delta 前发生不可恢复错误时可回退 V1，开始输出后不得混合两条链路。一个用户可见问题仍只计一次现有聊天额度，内部步骤受令牌、时长与模型调用预算限制。

## Risks / Trade-offs

- [Deep 研究增加延迟与模型成本] → 批量五条、并发三批、分层深读、每阶段预算和后台运行；普通事实问题仍走 fast。
- [追加事件与片段增加数据库体积] → 事件只存安全结构和有界片段，禁止媒体/凭据，按 Thread 级联删除，并对大 payload 硬限制。
- [旧线程与 V2 记忆语义不同] → 首次 V2 Turn 从旧消息生成一次 bootstrap checkpoint，旧消息展示不变。
- [自动路由误判] → 确定性特征与结构化分类结合，保留高级 fast/deep 覆盖，并记录 resolved mode 供评估。
- [多实例重复执行] → 原子认领、lease token、独立 heartbeat 和提交前所有权校验。
- [模型修复仍可能失败] → 正文从服务端认可的 Claim/Evidence 渲染，失败时明确输出依据不足而不是保留未验证引用。

## Migration Plan

1. 创建 OpenSpec 与加法数据库表/索引，部署时 V2 默认关闭。
2. 实现自动路由、Claim/Evidence 验证和 Turn/Event 运行时；用假模型及现有真实 37 视频问题离线评估。
3. Harness 接入 auto、默认仅视频、持久进度/恢复与 Claim 证据 UI；旧 SSE 类型继续解析。
4. 管理员白名单开启，再按 5%→25%→100% 灰度；记录 V1/V2 质量、成本、延迟与错误。
5. 回滚只关闭 V2 开关，旧表保留；旧 Thread/Message 与 V1 链路始终可用。

## Open Questions

无。产品决策已锁定为自动研究、默认仅视频、分层研究全部来源和灰度双轨。
