# Agent Runtime 第三方实现归属

知萃的视频研究 Agent 保持 Python/FastAPI/SQLAlchemy 技术栈，未链接或嵌入
DeepSeek Harness、OpenAI Codex 的 Node/Rust 运行时。以下部分基于许可证允许的
第一方源码进行移植或改写：

- DeepSeek Harness，MIT License，参考提交 `528c682e0616`：
  - `packages/guard/repeat-tool-reminder/src/index.ts` 的参数规范化、连续调用链、
    提醒阈值思想，被改写为
    `backend/app/services/agent_repeat_tool_guard.py`；知萃在第五次调用时终止路径。
  - 追加式事件投影、压缩事务的架构模式被用于 AgentTurn/AgentEvent 与记忆检查点，
    代码按知萃数据模型重新实现。
  - `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx`、
    `ToolCallTree.tsx` 与 `AssistantNodeView.tsx` 的稳定 keyed 工具行、运行/完成/中断
    原位更新和紧凑状态摘要模式，被改写为知萃的
    `AgentActivityTimeline.tsx` 与 `agentTurnUi.ts`；没有复制其通用工具详情或运行时。
  - `packages/client/runtime/src/client/contract/store.ts` 和
    `sessions/notifier.ts` 的 animation-frame 通知合并、generation 作废旧调度模式，
    被改写为 `frontend/src/lib/agentTextStream.ts` 的帧级正文发布与终态保护。
- OpenAI Codex，Apache License 2.0，参考提交 `536f86e5cc9e`：
  - Turn/Step 生命周期、稳定上下文分区、工具结果限界、压缩后继续执行的模式，
    被用于持久 Turn、租约提交保护和有界会话上下文；未复制 Shell、沙箱、文件编辑器
    或供应商协议实现。
  - `codex-rs/app-server-protocol/src/protocol/event_mapping.rs` 与
    `protocol/v2/item.rs` 中将 item started/completed 和 agent message delta 分离的
    事件语义，被改写为 `turn.map.batch.*`、`turn.answer.started`、
    `turn.answer.delta` 及可按单调序号恢复的 SSE 投影。
  - Codex 应用中“执行摘要让位于正文”的阅读层级被适配为知萃的单一回答流：首段正文
    到达后，步骤区自动收拢成可重新展开的一行摘要；持久化增量按 32–48 字切分，
    观点标题与解释持续投影，引用标识和内部 JSON 不进入草稿流。
  - `codex-rs/tui/src/streaming/controller.rs`、`chunking.rs` 和
    `commit_tick.rs` 的稳定队列、平滑/追赶两档提交与完成消息权威收口模式，被改写为
    浏览器字符队列：常态有界小步显示，积压深度或等待年龄越界时批量追赶，刷新重放
    严重积压时立即追平；最终仍由服务端 canonical message 原子替换。

随发布包保留的许可证文本位于 `docs/licenses/deepseek-harness-MIT.txt`、
`docs/licenses/openai-codex-Apache-2.0.txt` 和
`docs/licenses/openai-codex-NOTICE.txt`。发布包含上述改写代码时，应同时分发这些
文件与本归属说明。
