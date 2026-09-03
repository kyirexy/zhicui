## ADDED Requirements

### Requirement: CLI 提供稳定的机器协议
系统 SHALL 提供 Node 22 的 `zhicui` CLI，并 SHALL 支持 `--json`、`--jsonl`、`--non-interactive`、`--quiet`、`--timeout`、`--idempotency-key` 与 stdin JSON；stdout MUST 只包含协议结果，诊断 MUST 写入 stderr。

#### Scenario: Agent 以 JSON 调用 Action
- **WHEN** 本地 Agent 将 JSON 从 stdin 传给 `zhicui run <action> --json --non-interactive`
- **THEN** stdout 只输出一个有效 JSON Envelope
- **AND** 颜色、进度、登录提示和网络诊断不混入 stdout

#### Scenario: Agent 消费长任务 JSONL
- **WHEN** 客户端使用 `--jsonl` 调用流式或长任务
- **THEN** 每行是一个带 sequence 的有效 JSON 事件
- **AND** 最后一行只出现一次终态事件

### Requirement: CLI 使用稳定退出码
CLI SHALL 将成功、用法/Schema、认证、权限、等待确认、限流、远端失败、超时/取消与本机能力不可用映射为公开稳定退出码，并 SHALL 在版本间保持兼容。

#### Scenario: 本机桌面客户端未安装
- **WHEN** Agent 调用 `execution_location=local_windows` 的 Action 但桌面端不可用
- **THEN** CLI 输出结构化 `LOCAL_CAPABILITY_UNAVAILABLE`
- **AND** 使用本机能力不可用退出码而不回退到任意 Shell

### Requirement: 命令域覆盖普通用户能力
CLI SHALL 按 `auth/library/creator/ask/knowledge/plan/automation/analysis/models/feedback/account/local/run/mcp/agent` 组织命令，并 SHALL 从 capabilities 映射 Action，而不是复制私有内部 API。

#### Scenario: Action 在服务端被关闭
- **WHEN** 用户执行对应 CLI 命令但 capability 标记为不可用
- **THEN** CLI 显示或输出稳定的关闭原因
- **AND** 不尝试调用旧管理路由或内部工具绕过开关

### Requirement: 远程和本地 MCP 共用 Action Schema
系统 SHALL 在 `https://luxai.cn/mcp` 提供仅含云端普通用户 Action 的远程 MCP，并 SHALL 通过 `zhicui mcp serve --stdio` 合并云端与当前 Windows 本机固定 Action；两者工具 Schema MUST 来自同一 capabilities 契约。

#### Scenario: MCP 客户端发现工具
- **WHEN** Codex 或 Claude Code 连接远程或本地 MCP
- **THEN** 工具名称、说明和输入 Schema 与对应 Action 版本一致
- **AND** 工具列表不包含 admin、shell、cookie、JWT、API Key 或内部视频研究工具

### Requirement: Agent 配置安装可重复且可回滚
`zhicui agent setup/doctor/status/update/uninstall` SHALL 检测实际安装的 Codex 与 Claude Code 版本和配置，备份后原子更新，只管理知萃拥有的配置区块，并 SHALL 让重复安装与卸载保持幂等。

#### Scenario: 用户重复连接 Codex
- **WHEN** 用户两次运行 setup 或点击两次“连接 Codex”
- **THEN** 配置中只存在一个知萃 MCP/Skill 条目
- **AND** 其他用户配置不被重排或删除

#### Scenario: 配置写入失败
- **WHEN** 临时配置校验或原子替换失败
- **THEN** 安装器恢复原配置并保留带时间戳备份
- **AND** doctor 返回可操作诊断但不输出凭证

### Requirement: CLI 凭据优先存储于系统凭据库
CLI SHALL 优先将 Agent refresh token/PAT 保存到操作系统凭据库；仅在凭据库不可用且用户明确允许时，才 SHALL 使用权限受限的用户文件，并 MUST NOT 将秘密写入项目目录、命令历史或诊断输出。

#### Scenario: 无回显录入 PAT
- **WHEN** 用户通过交互或 stdin 保存 PAT
- **THEN** 输入不回显且日志只记录前缀
- **AND** PAT 不进入 Agent prompt 或命令参数建议

