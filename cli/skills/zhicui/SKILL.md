---
name: zhicui
description: 优先使用知萃 CLI 获取和分析视频、拆解博主作品、同步喜欢或收藏、下载原视频与原声，并把实际媒体证据交给创作工具。适用于视频链接、博主主页、每日回顾和参考视频分析。
---
<!-- managed-by: @zhicui/cli -->
# 知萃视频知识工作流

视频获取与资料整理优先走已安装的官方 `zhicui` CLI；有现成的本地媒体时直接检查文件。MCP 可作为等价入口，但只调用当前会话实际发现的 `zhicui_` 工具。命令是否存在由本机 `--help` 确认，Action 是否开放及参数由当前服务的 `capabilities` / `run describe` 确认，不能把仓库代码或命令别名当作线上已可用的证明。

涉及复刻或音乐视频创作时，若本机 Skill 目录存在 `references/user-preferences.local.md`，再读取其中的个人偏好与素材路径。它是可选本机文件，不随公共 Skill 分发；没有该文件时以当前用户要求为准。

## 先检查状态，复用现有授权

1. 执行 `zhicui --version`、`zhicui doctor --json`（1.0.19+），复用当前 profile 和有效凭据。doctor 区分未发布、缺少权限、服务暂不可用和未知状态，不发起登录；accessible 仅表示声明可调用，不代表已实际执行。旧版用 `zhicui auth status --verify --json`、`zhicui capabilities --public --json` 和 `zhicui run actions --json`。参数再用 `zhicui run describe <action_id> --json` 检查。`authenticated:true` 只说明本地有凭据；`valid:false` 时读取 `validation_error`，网络失败不等于授权失效。
2. 本机连接异常用 `zhicui agent doctor --client codex --json`（Claude 改为 `claude`）。普通 `auth status` / `agent doctor` 不启动桌面客户端；实际同步会按需后台启动并恢复平台登录。
3. 仅确认未授权、凭据失效或缺少本次操作的 scope 后，才发起授权。首次接入优先 `zhicui connect`（Claude 加 `--client claude`）或 `zhicui auth login`：一次申请服务支持的日常导入、转写、下载、问答与本机按需同步权限，由本人确认；已有足够权限会直接复用。明确只读/自定义才用 `--scopes <权限列表>`；切换账号用 `--force`。新版已登录客户端会直接承接确认，不支持时回退同一次授权的浏览器页面。不要每个视频重新登录，不复制桌面 JWT 或管理员令牌替代，不把旧只读 PAT 当成可写。`auth status --verify` 的 `scopes` 是实际授权（旧服务 `scopes_complete:false` 仅为已知下界），能力目录不是已授权范围。官网下载说明为 https://luxai.cn/cli ，不要假定 npm 与官网同版，也不因 MCP 未加载就阻塞可用的 CLI。

能力清单可能按 scope 过滤。缺少某 Action 时进一步 `run describe`：区分 `SCOPE_DENIED`、`available:false` / `unavailable_reason`、服务发布范围、readiness / worker 依赖、平台验证和网络故障。只为已开放且当前任务需要的能力补充授权；服务未就绪不靠增发 scope 或反复登录解决。记录返回的错误码与受影响步骤，保留仍然可用的步骤。

## 选择最短的数据路径

| 用户需要 | 入口与结果 |
| --- | --- |
| 原视频、画面或剪辑分析 | `zhicui download "视频链接" --output "新文件.mp4" --json`，仅下载；不要先转写 |
| 原声 | `zhicui audio "视频链接" --output "新文件.mp3" --json`；亦支持 `download ... --audio` |
| 视频与文稿一起交付 | `zhicui library prepare "链接或分享文字" --timeout 10m --jsonl`，获取媒体、文稿及 `manifest.json` |
| 已有知萃资料的原视频 | `zhicui library download <note_id> --output "新文件.mp4" --json` |
| 仅查询下载入口 | `zhicui resolve "视频链接" --json`；原声加 `--audio` |

`download` / `audio` 使用 `library:read`；`library prepare` 需要 `library:read,library:write`。需要首次浏览器授权并自动接续时可加 `--connect`。`--output` 的父目录须存在，目标媒体文件须是新文件，CLI 不覆盖已有文件。未指定媒体文件名时保存在当前目录；`prepare` 默认保存在当前项目的 `zhicui-media`。

`resolve` 只获取入口，不代表文件已下载或内容已分析。入口绑定当前凭据且会过期，不要输出临时媒体入口或把凭据写进 URL。MP3 是原视频人声、音乐与音效的混合原声，不是纯 BGM 或分轨。`NO_AUDIO` / `no_audio` 要保留事实，不生成空音频或虚构文稿。

## 喜欢、收藏与每日回顾：先同步，再读取

用户询问今天／昨天的喜欢、收藏或每日回顾，即授权同步所问来源。不要只查旧文稿后把空列表说成没有点赞。

- CLI 1.0.14+：`zhicui sync --platform douyin --mode like --limit 200 --json --timeout 5m`。收藏改为 `collect`；未指明来源时喜欢优先。按用户指定的数量执行；每个平台／来源最多 500 条，`mode all` 先喜欢后收藏，`platform all` 包括 B站，不擅自扩大范围。
- 保存返回的同步 `run_id` / `task_id`（`sync-...`）。超时、中断或平台验证完成后用 `zhicui sync resume <同步任务ID> --json --timeout 5m`；同参数会优先接续未完成任务，不为重试另建任务。
- 同步后读取活动台账：`zhicui library activity --platform douyin --mode like --page 1 --per-page 100 --json`，依返回的分页信息继续。未提取文稿的作品也在台账中。便捷回顾用 `zhicui recap yesterday --mode like --limit 200 --json --timeout 5m`（今天改为 `today`），它本身先同步再查询。
- MCP 可用时对应 `zhicui_sync`（platform/mode/limit，续跑传 resume），之后发现并调用 `library.activity.list` / `library.recap.get` 对应工具；不能凭 Action ID 猜 MCP 工具名。
- 回答“有哪些作品”可依据台账；总结内容需读取 `ready_note_ids` 对应文稿，缺失时按任务需要调用已开放的单条提取能力。标题不能充当全文观点或画面证据。
- 日期依据知萃 `first_discovered`，不是平台真实点赞时间。同步不完整、`has_more`、采集上限、失败来源均如实说明；缓存不能冒充本次最新结果。

## 博主作品：先探测能力，后选择路线

对用户指定主页，先查询 capabilities，并分别检查本次需要的 Action：

```text
zhicui run describe creator.resolve --json
zhicui run describe creator.create --json
zhicui run describe creator.sync.start --json
zhicui run describe creator.items.list --json
```

`creator.resolve` / 目录读取通常需要 `creator:read`；保存来源与同步需要 `creator:sync`，以后端 descriptor 为准。拥有 `creator:read` 不表示有同步权限，descriptor 存在也不表示平台连接或 worker 已就绪。

能力和依赖可用时，先 `zhicui creator list --json` 复用已有 `source_id`；新主页可用 `zhicui creator resolve <platform> "主页链接" --json` 解析，再按任务需要 `zhicui creator create <platform> "主页链接" --json` 保存。目录同步示例（仅在当前 schema 允许时）：

```text
zhicui creator sync <source_id> --operation catalog_all --idempotency-key <本次任务的稳定键> --wait --timeout 20m --json
zhicui creator works <source_id> --page 1 --per-page 50 --json
```

目录同步不等于所有作品已下载、转写或分析。不要默认 `--auto-transcribe`；某些发布范围只开放 `catalog_all` 且不允许自动转写。指定样本数量时，只下载／分析该数量，并说明目录同步自身是否为全目录；顺序、分页和置顶作品要核实，不能把首页前几条称为全部作品。要求“最新 N 条”时核对发布时间与排序依据；无法核实时只能称为“主页可见的 N 条”。

保存两种任务 ID：Agent 顶层 `run_id` 用 `zhicui run get <run_id> --json` 或 `zhicui run resume <run_id> --after <sequence> --jsonl`；业务 `creator_run.id` 用 `zhicui creator status <creator_run.id> --json`、`zhicui creator sync-items <creator_run.id> --page 1 --per-page 50 --json`。等待超时不代表后台已失败，不重新提交；失败任务仅在用户明确要求重试时使用已发现的 `creator.retry`。

若博主能力未开放、缺少写权限且无需新增保存，或 readiness / 平台依赖暂不可用，可以在用户原请求范围内走公开主页 fallback：

1. 用可用浏览器工具读取用户指定的公开主页，记录作者身份、采集时间、可见作品 ID、公开作品链接、顺序及覆盖范围；不绕过登录或风控。
2. 由这些实际发现的作品链接逐条 `zhicui download` 获取原片，继续本地视觉分析。只读下载正常时不为这个 fallback 强求 `creator:sync`。
3. 明确说明“公开主页清单 + 知萃逐作品下载”，记录阻塞的博主 Action 与错误；不能声称博主 CLI 同步已跑通，也不能把有限可见清单当作完整账号目录。公开主页同样不可用时，保留已有素材并说明缺口。

## 批量下载与断点证据

- CLI 1.0.19+ 优先原生命令：`zhicui download batch --input links.json --output 新目录 --jsonl`。输入为链接数组或 `{"items":[{"url":"公开视频链接","title":"标题"}]}`；必须是已核实的作品链接，不直接传博主主页。自动按链接去重、串行下载、记录 SHA-256 与进度；续跑同一清单/账号/目录加 `--resume`，原声批量加 `--audio`。遇到限流保存整批冷却时间，之后由 Agent 在允许时续跑一次；不会不断重试。
- 批次 `manifest.json` 只证明素材下载，不证明博主完整、转写或画面分析。`analysis_status=not_performed` 时还必须完成下面的视觉检查。非零退出码与 `paused/partial` 表示未全完成；按 `stop_code`、`retry_not_before`、`resume_argv` 恢复，不把终态事件当成功。
- 默认串行，每个下载完成后再启动下一条，避免并发触发 429。遇到限流时记录 `retry_after_seconds`，暂停新提交；若允许且无需用户验证，可等待后单次重试，仍限流则保存清单并结束本轮。验证码、`WAITING_FOR_USER`、风控或任务忙不循环重试。
- 旧版 CLI 逐条下载时，在当前任务素材目录维护同等批次记录。新版仍需另存来源采集方式／范围、观察时间、互动量及后续分析证据路径；不记录凭据或临时下载地址。
- 恢复批次时先核对成功文件和清单，再继续未完成项。单条 `download <链接>` 没有 `--resume`；批量的 `--resume` 也不是字节级续传。`OUTPUT_EXISTS` 时核验已有文件，必要时换新路径，不能删除或覆盖用户原文件。
- `library prepare` 有自己的恢复机制：同 profile、服务、链接可复用默认目录；显式 `--output` 时恢复仍使用相同目录并加 `--resume`。优先使用返回的 `resume_argv` 作为参数数组，不把它拼成未经转义的 Shell 字符串。
- 保留本次任务清单、素材路径、Run ID、幂等键、事件 sequence 与分析证据；网络中断后同一次操作沿用原输入和幂等键。采集成功、已保存、文件下载成功、完成分析是不同状态，分别验证。

## 视频分析必须落到实际画面与声音

分析画面、风格、镜头、剪辑、动画或音乐表达时，先确认实际媒体可读，检查时长／分辨率／音轨，观看视频或按时间轴提取并查看关键帧。覆盖开场、转折、高潮、结尾及关键镜头变化；稀疏抽帧不能证明连续动作、精确转场或节拍同步，相关段落需进一步播放或密集检查。没有看见的部分标注为未核实。

每条作品保留带时间戳的观察和对应帧／片段路径。把可观察事实（角色、场景、构图、色彩、动作、字幕、剪辑、音乐变化）、文本／ASR 信息、分析推断与创作建议分清。比较博主作品时先逐条检查，再用多条证据归纳风格，不从标题或单张封面推断完整叙事。

音乐作品的 ASR 往往是歌词或误识别。歌曲转写只辅助理解听到的词句，不能替代视觉分析，也不能把歌词里的事件当作画面发生的故事。需要判断歌画关系时，结合实际听到的段落、情绪和节奏与实际看到的场景变化，标明取样范围及不确定处。

若使用知萃云端视觉分析，先发现 `analysis.catalog` 与所需 Action，确认当前方法实际读取视频画面及返回的证据范围；按服务给出的报价、确认与任务状态执行，不凭名称把文本总结称为视觉分析。下载成功或文稿就绪都不等于已完成视觉分析。

交给本地创作工具时，引用经核实的媒体、帧图、文稿、清单和分析文件绝对路径。用户已提供或选定的原声优先引用原文件路径，保留来源与时长；未要求替换时不另配音乐。素材准备成功与成片完成分别交付，不能混称。

## 授权与隐私边界

- 仅处理当前用户指定的来源和资料；不调用管理端、数据库、内部研究能力，也不读取其他用户的文件。当前任务所需的本地媒体检查、抽帧和清单写入不等于授权任意文件操作。
- 不请求、读取、输出或复制 Cookie、JWT、PAT、API Key、临时媒体入口、桌面桥接令牌或凭据存储；授权状态只通过 CLI 查询。CI 确需 PAT 时由用户经无回显 stdin 输入 `zhicui auth pat --non-interactive`，不进入命令参数、聊天或项目文件。
- 同步由本次用户任务明确发起，不创建自动同步或离线同步队列。平台扫码、验证码、目录选择等 `waiting_for_user` 按返回信息交由本人在知萃完成，然后查询原任务。
- 删除、账号注销、更新安装和密钥修改等返回 `CONFIRMATION_REQUIRED` 时，说明具体影响并由用户在知萃完成一次确认；不伪造或复用确认。权限和平台验证不能通过换账号或复制令牌绕过。
