# 快速视频下载接入（2026-09-28）

用户目标：拿到下载入口要快，Web 与 CLI 都可用，Agent 接入路径要短，直接部署。

## 最终路径

- Web：`/video-download`，桌面导航「视频下载」，单条解析页也可进入。支持获取入口、复制平台直链、下载进度、取消及重新获取；无需先导入资料或 ASR。
- 本机 CLI 1.0.9：`zhicui download '<链接>' --connect`；只获取入口用 `zhicui resolve '<链接>' --json`。
- MCP：`library.media.resolve`（本地 stdio 工具 `zhicui_library_media_resolve`），仅 `library:read`。
- 已有账号授权直接复用；缺少授权时 `--connect` 走已有设备授权，浏览器确认后继续同一任务。

## 实现与边界

公共元数据路由参考 parse-video-py MIT 实现，保留版权声明。知萃不引入 Docker 或独立解析进程。解析阶段不发起媒体 GET，短链和元数据使用 DNS 固定、TLS 主机校验及连接池。

媒体在用户下载时从平台流式传输，经 MP4 首块校验后立即发送，不先保存整个文件。保留域名/公网 IP/每跳重定向校验、512MB/240秒预算、单用户并发限制。凭证仅发往知萃；上游不接收用户 PAT/JWT/Cookie。

下载入口以 Fernet 加密，绑定用户及具体 Agent 凭证，五分钟有效。下载时再次鉴权和检查 scope / rollout / 撤销状态。Web 登录会话可复制平台直链；Action/MCP 输出不包含平台临时媒体地址，历史记录只保留绑定凭证的加密入口。

没有导入资料或数据库 schema 变更。Core Registry 从 41 扩展到 42 个显式 Action；Full 从 126 到 127。两个清单重新生成校验。

B站保留既有元数据路线；分离音视频和非 MP4 返回明确提示，继续使用资料页的合并下载，不谎称直接下载包含声音。

## 验证

服务器侧预部署实测同一条用户链接：元数据 493ms，首块 164ms，完整文件 820ms，5,450,772 字节。
正式发布后的 CLI / Web / MCP 验收结果在本文件后续补充，不以此预部署探测代替正式发布验证。

覆盖：跨用户/跨凭证拒绝、过期和篡改入口、Web 与 Agent 鉴权、解析不预下载媒体、缓存按用户隔离、CLI 不导入不 ASR、原子文件、JSONL 单终态、能力清单及现有接口回归。

### 构建和发布前检查

- 后端相关 unittest：86 项通过；前端正式构建、TypeScript 及相关导航/接入测试通过。
- CLI Windows 初轮 116 项通过；1.0.8 复测一项 Windows 命令探测超时，单独复跑该文件 4 项通过。Linux 发布环境最终 104 项通过、12 项按平台跳过，无失败。
- npm 12 的 `pack --json` 从数组改为按包名索引的对象，发布审计已兼容两种格式，仍保留原来的包名、版本、入口和文件白名单检查。
- 1.0.9 公共 npm 发布被 npm 返回 E403：账号要求 2FA 或满足其要求的发布凭证。没有关闭 2FA、绕过检查或声称 npm 已发布。本机安装经过相同文件审计的构建包，并更新 Codex 的受管 Skill（自动保留旧文件备份）。
- Jenkins 310 因海外 npm 大包传输过慢主动终止；已把与锁文件相符的官方同版本依赖写入 npm 内容缓存，Jenkins 311 从完整发布流程重试，不跳过构建、备份或验收。

### 正式发布结果

- 2026-09-28 12:40（北京时间）：Core 发布完成，commit `68413f8c3fec110d94bf4cd73d890a95a5ee61ee`，deployment `manual-single-video-fast-68413f8-20260928T043330`。Jenkins 311 dark、隔离恢复演练、Core 的 Action/PAT/MCP、AI SSE 和用户旅程检查全部通过。临时冒烟密码租约已恢复，临时明文已删除。
- `https://luxai.cn/video-download` 返回 200；未登录调用 resolve 返回 401。
- 正式 Web API（普通测试账号、真实公网域名）：首次 HTTP 903ms，其中解析 880ms、媒体预下载 0 字节；缓存命中 HTTP 16ms。流式下载首块 316ms，总传输 15.808s，5,450,772 字节。浏览器桥接不可用，未声称完成视觉点击验收。
- 本机 CLI 1.0.9 调用正式接口：强制重新解析 515ms，含进程启动、凭据读取和网络的命令总时长 1.234s。完整下载命令 15.934s，实际文件 `D:/6month/.artifacts/fast-video-production.mp4`。下载入口速度与完整传输速度分别记录，不把缓存耗时说成冷启动耗时。
- Web/CLI 文件 SHA-256 均为 `171471ec6bbd0f3c0f9da19b0d04173a3f5646c4199626386538df674ba7ec23`，与原测试视频一致。
- 真实 stdio MCP：发现 `zhicui_library_media_resolve`，实际调用成功；复用用户此前存储的有效 PAT 到原本空白的默认 CLI 配置，未打印令牌、未扩权，继续使用 Windows DPAPI。`zhicui agent doctor --client codex` 返回 READY，configuration_ready/authenticated/cloud_available/mcp_healthy 全为 true。
- npm 公共包仍未发布（2FA E403）。本机 CLI 已安装并验收；不能把 `npx @zhicui/cli@1.0.9` 描述为已经可用。
