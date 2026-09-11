# @zhicui/cli

知萃普通用户能力的 Node 22 CLI 与本地 MCP 入口。它只调用版本化 Action 接口，不包含管理端、数据库、任意 Shell、Cookie、JWT、API Key 或内部视频研究工具。

```bash
npx @zhicui/cli auth login
npx @zhicui/cli library list --json
npx @zhicui/cli creator --help --json
npx @zhicui/cli run actions --json
npx @zhicui/cli mcp serve --stdio
```

设备授权默认只申请普通用户的只读 scope；需要导入、同步、提问或修改计划时，
请在授权中心明确增选对应写入 scope，CLI 不会自行扩权。

需要录入视频、同步博主、问答和生成计划时，可明确申请这些权限，再在浏览器批准：

```bash
zhicui auth login --scopes account:read,library:read,library:write,creator:read,creator:sync,ask:read,ask:run,plan:read,plan:write,analysis:read,analysis:run
```

完整视频工作流（尖括号是上一条命令返回的真实 ID，执行时替换）：

```bash
# 保存指定博主，再只同步全部视频目录
zhicui creator create douyin "https://v.douyin.com/bJThxAvzUaY/" --json
zhicui creator sync <source_id> --operation catalog_all --idempotency-key creator-catalog-001 --wait --timeout 20m --json
zhicui creator works <source_id> --per-page 50 --json

# 选定目录中的作品提取文稿；也可 --operation recent_transcript --limit 20（支持 20/50/100）
zhicui creator sync <source_id> --operation selected_transcript --item-ids '["<item_id>"]' --idempotency-key creator-transcript-001 --wait --timeout 20m --json

# 云端分享链接导入当前支持 B站和小红书，查看可供问答的资料 ID
zhicui library import "<B站或小红书分享链接>" --idempotency-key import-001 --wait --timeout 20m --json
zhicui ask sources --scope all_ready --json

# 先选择文稿创建会话；单视频放一个 source_id，多视频放多个
zhicui ask create --source-scope selected --source-ids '["<source_id_1>","<source_id_2>"]' --title "视频对比" --idempotency-key conversation-001 --json
zhicui ask start <thread_id> turn-001 "这些视频有哪些共同建议和不同观点？请引用来源。" --idempotency-key question-001 --jsonl --timeout 20m

# 从一条视频文稿生成可执行计划，并查看结果
zhicui plan from-video <note_id> "整理为两周可执行计划，每天不超过30分钟" --idempotency-key video-plan-001 --wait --timeout 20m --json
zhicui plan list --json
zhicui plan task-complete <plan_id> <task_id> true --idempotency-key task-complete-001 --json
```

`creator works` 中每条作品的 `id` 用作 `item_ids`；问答 `source_ids` 使用 `ask sources` 返回的资料 ID；`thread_id` 来自 `ask create`。博主的多视频问答也要先准备所选作品文稿，再用对应资料 ID 创建会话；同步目录不会直接转写全部作品。首次执行的业务结果在 JSON 的 `data.result` 内，幂等重放及 `run get` 的持久结果在 `data.run.data` 内。

数组、对象参数支持 JSON，也可以通过 stdin 提供完整输入（PowerShell 使用单引号保存 JSON）：

```powershell
'{"source_scope":"selected","source_ids":["<source_id>"],"title":"单视频问答"}' | zhicui ask create --idempotency-key conversation-002 --json --non-interactive
```

每次新操作换一个幂等键；网络中断后重试同一次操作沿用原键和原输入。长任务的顶层 `run_id` 用于 `zhicui run get|wait|resume`；`creator_run.id` 是博主同步记录，只用于 `creator status|sync-items|retry|cancel`。`run resume <run_id> --after <sequence> --jsonl` 可续读事件。等待超时会返回退出码 8，后台任务仍可通过已有 `run_id` 查询，不必重复提交。

昨天新同步的资料可用 `zhicui ask sources --scope yesterday --timezone Asia/Shanghai --json` 查看，再用 `ask create --source-scope yesterday --timezone Asia/Shanghai --idempotency-key yesterday-thread-001` 创建会话。该范围依赖已完成的手动同步记录，不等同于平台真实点赞时间。抖音通过博主同步或桌面本机同步进入资料库；`library import` 当前不支持抖音单链接导入。

详细画面解析先用 `analysis catalog` 查看方案，`analysis prepare --note-ids '["<note_id>"]' --idempotency-key analysis-prepare-001` 准备报价；计费或破坏性动作若返回 `CONFIRMATION_REQUIRED`，在知萃界面批准本次确认后，沿用原输入和幂等键，并添加 `--confirmation-id <confirmation_id>`。CLI 不跳过计费或删除确认。

所有普通用户 Action 都可通过 `zhicui run actions --json` 发现；`zhicui run describe <action_id> --json` 返回当前服务的准确参数 Schema、权限与确认要求，`zhicui run <action_id> --field-name ...` 可直接调用。常用命令还可通过 `creator/ask/plan/analysis --help` 查看，无需登录。

平台账号由每个用户自行绑定。知萃登录用于访问自己的资料与计划；B站、抖音等平台登录用于读取该用户授权的平台内容。未连接平台不会阻止查询已保存的知萃资料，但需要平台授权的同步应先完成对应平台连接。

Windows 桌面客户端与 CLI 必须登录同一个知萃账号。用户可从 CLI 发起官方登录窗口，在窗口中自行扫码或登录，CLI 不接收平台密码、Cookie，也不能指定其他用户的账号：

```bash
zhicui local platform-login bilibili --json
# 用户在 B站官方窗口完成授权，再查询本次连接操作结果
zhicui local platform-status bilibili --json
zhicui local platform-sync bilibili collect --limit 50 --json
# 断开时由桌面端确认，只清理当前用户的平台会话
zhicui local platform-disconnect bilibili --json
```

上述桌面绑定只保存在当前电脑。云端 B站同步使用独立的个人授权，无需安装桌面客户端：

```bash
zhicui platform bind bilibili --json
# 打开返回的 login_url，登录与 CLI 相同的知萃账号，用 B站 App 扫码确认
zhicui platform status bilibili --json
# 需要从命令行查询扫码进度时，使用 bind 返回的 session_id
zhicui platform poll bilibili <session_id> --json
zhicui creator sync <source_id> --operation catalog_all --wait --json
zhicui platform disconnect bilibili --json
# 断开属于需确认的操作，按返回的 confirmation_id 完成确认
```

云端授权加密存储，绑定、状态和断开都只作用于当前知萃用户。取消或换绑后，旧二维码不能重新建立绑定；授权过期会停止同步并提示重新绑定。系统不会使用管理员或其他用户的 B站账号作为后备。`catalog_all` 同步的是博主公开投稿目录；桌面端点赞、收藏同步仍使用 `local platform-sync`。

Windows 客户端运行时还可调用固定本机动作：

```bash
zhicui local platform-sync douyin like --limit 50 --json
zhicui local platform-status douyin --json
zhicui local platform-cancel --json
zhicui local media-open <aweme_id> --json
```

本机动作返回的 `run_id` 只属于桌面桥。CLI 不会把它发送到云端 Run 接口；
请用 `local platform-status <platform>` 查看进度。桌面桥只使用客户端当前
登录的知萃账号，CLI 不能自行指定其他账号的 `profile_key`。

PAT 只能从无回显 stdin 保存：

```bash
printf '%s' "$ZHICUI_PAT" | zhicui auth pat --non-interactive --json
```

Codex / Claude Code 接入使用实际安装版本自带的 MCP 管理命令，配置前创建备份，失败时恢复：

```bash
zhicui agent setup --client all --json
zhicui agent doctor --client all --json
zhicui agent uninstall --client all --json
```

稳定退出码：`0` 成功、`2` 用法/Schema、`3` 认证、`4` 权限、`5` 确认或等待用户、`6` 限流、`7` 远端失败、`8` 超时/取消、`9` 本机能力不可用。

同一凭据的并发命令会协调读写和续期，进程退出留下的新版锁可自动恢复。升级 CLI 时先结束旧版命令，避免混用不同锁协议；若提示“等待旧版 CLI 刷新锁超时”，须确认旧版 CLI/MCP 进程全部退出后再检查配置目录内的旧 `refresh-*.lock` 空目录。新版不会仅凭目录时间删除可能仍在使用的旧锁。

环境变量：

- 正式 CLI 固定连接 `https://luxai.cn`。仓库开发测试可显式设置 `ZHICUI_CLI_DEV=1` 与本机回环 `ZHICUI_API_URL`；凭据按服务来源隔离，不能跨来源复用。
- `ZHICUI_PROFILE`：本机凭据配置名，默认 `default`。
- `ZHICUI_CONFIG_HOME`：CLI 非秘密配置目录。
- `ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS=1`：系统凭据库不可用时，明确允许退回权限为 0600 的用户配置文件；默认拒绝该降级。
- `ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR`：受信桌面桥描述文件位置；不接受远端地址。

发布包不包含凭据。npm 正式发布与 Windows Authenticode 由发布流水线注入身份，源码不保存发布令牌或证书。
