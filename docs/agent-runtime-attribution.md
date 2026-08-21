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
- OpenAI Codex，Apache License 2.0，参考提交 `536f86e5cc9e`：
  - Turn/Step 生命周期、稳定上下文分区、工具结果限界、压缩后继续执行的模式，
    被用于持久 Turn、租约提交保护和有界会话上下文；未复制 Shell、沙箱、文件编辑器
    或供应商协议实现。

随发布包保留的许可证文本位于 `docs/licenses/deepseek-harness-MIT.txt`、
`docs/licenses/openai-codex-Apache-2.0.txt` 和
`docs/licenses/openai-codex-NOTICE.txt`。发布包含上述改写代码时，应同时分发这些
文件与本归属说明。
