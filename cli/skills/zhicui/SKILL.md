<!-- managed-by: @zhicui/cli -->
# 知萃视频知识工作流

使用知萃 MCP 工具处理用户自己的视频资料、博主作品、知识页和行动计划。

尚未接入时，官网下载说明位于 https://luxai.cn/cli 。已安装 CLI 1.0.10 及以上可运行 `zhicui connect`（Claude Code 加 `--client claude`），复用有效凭据或引导浏览器授权，再检查工具是否可用；请勿让用户在聊天中粘贴密钥。官网安装包独立发行，不要假定 npm 仓库已经发布同版本。

## 使用边界

- MCP 只调用 `zhicui_` 前缀且由当前会话发现的工具；用户明确要求 CLI 或交付本地素材时，可以调用已安装的官方 `zhicui` 命令。
- 不请求或输出 Cookie、JWT、PAT、API Key、临时媒体地址或桌面桥接令牌。
- 不尝试调用管理端、数据库、任意 Shell、任意文件系统或内部研究工具。
- 同步必须由用户或当前 Agent 明确发起；不要创建自动同步、离线同步队列，也不要在平台风控后连续重试。
- 删除、账号注销、本地文件删除、更新安装和密钥修改若返回 `CONFIRMATION_REQUIRED`，向用户解释影响并等待用户在知萃界面完成一次确认；不得伪造或复用确认。
- 扫码、验证码和目录选择若返回 `waiting_for_user`，提示用户在知萃 Windows 客户端完成对应操作后，再查询 Run。

## 推荐流程

### 用户询问今天／昨天的喜欢、收藏或每日回顾

这种请求本身就是一次同步授权。每次都先同步，再读取回顾，不能只查询旧文稿后把空列表说成用户没点赞。

- 首选已安装 CLI 1.0.12+：`zhicui recap yesterday --mode like --connect --json --timeout 5m`。今天改为 `today`；收藏用 `--mode collect`，两者用 `--mode all`；指定平台时加 `--platform douyin` 或 `--platform bilibili`。默认每个平台最近 50 条，不自发扩大为全量。页面短暂等待时继续查询同一任务，完成后自动保存并回顾，不重复提交；确需验证时提示用户在平台窗口完成。
- 同步复用当前用户的桌面平台登录；缺少知萃授权时由用户在浏览器确认，平台登录或验证码仍由本人完成。不能改用其他用户的绑定。
- 先根据返回的清单回答“看了什么”。若要求内容总结，再读取 `ready_note_ids` 的现有文稿；缺少文稿时使用公开的单条提取 Action，不要把目录标题写成全文观点。
- `sync.completed=false` 时明确哪些来源失败；整个同步失败时不要把缓存结果宣称为最新。`WAITING_FOR_USER`、风控或任务忙时停止重复提交，按返回的平台和 Run ID 查询进度。
- 日期依据 `first_discovered`（知萃首次同步），不是平台真实点赞时间。今天补同步出来的旧视频不能写成昨天点赞；`has_more` 或有限采集范围也要如实说明。
- 若直接使用 MCP，依次调用当前发现的本机同步/状态、`library.activity.record`、`library.recap.get`；本机 Run 只能向本机状态工具查询。不能在同步仅启动时就宣称同步已完成。

1. 先查看 capabilities 或资料列表，确认 Action 可用且 scope 足够。
2. 导入或同步只提交用户明确指定的来源和数量。
3. 长任务保存 `run_id`，使用 Run 查询/事件续传，不重复提交同一任务；重试时沿用幂等键。
4. 多视频提问前确认选中的视频文稿已就绪；回答引用知萃返回的来源信息，不把模型推断写成原文事实。
5. 本机能力不可用时，返回结构化原因并建议启动/登录知萃 Windows 客户端；不要回退到 Shell 或浏览器自动化。

## 音频提取与下载

- CLI 1.0.13+：`zhicui audio "视频链接" --output 原声.mp3 --json`；也可用 `zhicui download "视频链接" --audio`。沿用现有 library:read 授权，不需要另发 Key。
- 获取入口用 `zhicui resolve "视频链接" --audio --json`，MCP 调用 `library.media.resolve` 时传 `kind:"audio"`。下载入口仍绑定当前用户及凭证。
- MP3 包含原视频中的人声、音乐和音效，不能称为纯 BGM 或人声分离。平台要求验证时停止重复提交；无音轨返回 `NO_AUDIO / 无音频`，不保存空文件。解析只获取入口，真正提取时需要读取原媒体。

## 将用户指定的视频交给本地创作工具

- 只要视频文件时优先用 `zhicui download '<链接>' --connect --json`（CLI 1.0.7 起），默认保存在当前目录。不要先导入或提取文稿。仅需下载入口时用 `zhicui resolve '<链接>' --json`，或发现并调用 `library.media.resolve` / `zhicui_library_media_resolve` MCP 工具；只需 `library:read`。入口绑定当前凭证，五分钟有效，不要把 PAT 放入 URL。

- CLI 1.0.5 起优先在目标项目目录使用 `zhicui library prepare '<链接或整段分享文字>' --connect --timeout 10m --jsonl`，获取视频、文稿与 `manifest.json`；缺少 `library:read`、`library:write` 时由用户在浏览器确认后接续原任务，不需要向聊天粘贴 PAT。
- 未指定 `--output` 时素材保存在当前项目的 `zhicui-media`；相同 profile、服务和链接重复运行同一命令即可恢复。若明确指定 `--output <新目录>`，恢复时仍加 `--resume`。失败时优先使用返回的 `resume_argv`，不要自己拼接 Shell 命令。
- 需要原视频而不重新提取时，使用 `zhicui library download <note_id> --output <新文件.mp4>`。这些固定命令不授权任意 Shell、文件删除或读取其他用户资料。
- 已有只读 PAT 不会自行扩权；权限不足时请求用户在知萃授权中心选择相应权限，不复制桌面 JWT 或管理员令牌替代。
- 保存返回的素材目录和 Run ID；超时或进程结束后用相同链接、目录和 `--resume` 继续。只有已经失败的任务会在用户明确恢复时发起下一次尝试。
- 无音频会在清单中标记 `no_audio`，不要编造文稿。下游工具应读取实际素材，知萃素材准备成功不等于复刻视频已生成。

## 凭据

推荐执行 `zhicui auth login` 完成浏览器设备授权。CI 使用 PAT 时，只通过无回显 stdin 传给 `zhicui auth pat --non-interactive`，不要把秘密放入命令参数、提示词或项目文件。
