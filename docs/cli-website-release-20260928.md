# 官网 CLI 安装与一条命令接入（2026-09-28）

用户选择先提供官网安装包和一条接入命令。npm 公共发布仍受账号 2FA/发布凭证限制；本次通过官网分发，不依赖 npm 上存在 `@zhicui/cli`。

## 已上线入口

- 安装指南：<https://luxai.cn/cli>（跳转到 `/download/cli/`）。
- 最新安装包：<https://luxai.cn/cli.tgz>。
- 不可变版本：<https://luxai.cn/download/cli/zhicui-cli-1.0.10.tgz>。
- 版本、来源和校验信息：<https://luxai.cn/download/cli/release.json>。
- Web 视频下载继续使用 <https://luxai.cn/video-download>，需要登录。

Windows PowerShell：

```powershell
npm install -g https://luxai.cn/cli.tgz; if ($LASTEXITCODE -eq 0) { zhicui connect }
```

macOS / Linux / CMD：

```sh
npm install -g https://luxai.cn/cli.tgz && zhicui connect
```

需要 Node.js 22.12+，以及已经安装的 Codex 或 Claude Code。默认连接 Codex；Claude Code 在 `connect` 后追加 `--client claude`。安装后只需 `zhicui connect`。

## 连接行为

`connect` 按顺序安装受管 MCP 和 Skill、检查授权、检查云端与真实 stdio MCP 工具。有效授权直接复用；缺少有效授权时走已有设备授权流程，由用户在浏览器核对权限后确认，不需要把 PAT 发给 Agent。

只有配置、有效授权、云端和真实 MCP 工具发现全部通过才返回 `READY`。拒绝授权、离线和配置冲突保留明确的失败结果；JSONL 只有一个终态。首次安装结束后需要在 Agent 中重新连接知萃 MCP。

`connect` 仅支持默认 profile，避免受管 MCP 使用默认凭证、检查却误用其他 profile。命名 profile 仍可用于独立 CLI 操作。

## 构建与来源验证

- CLI 版本：`1.0.10`。
- 源提交：`299186ad60429b9fc5d0964cad75754bb78e17ce`。
- 发布标签：`cli-v1.0.10`。
- CI：<https://github.com/kyirexy/zhicui/actions/runs/36385761260>，结果 `success`。
- Windows 本地测试：120 通过；Linux CI：108 通过、12 项按平台跳过、0 失败。
- 包大小：75,467 字节；没有运行时 npm 依赖。
- SHA-256：`38eba6f8385c04ee9a4f50f9c90c46a378bb2b091b7008e2f1de749213679dce`。
- 已通过 `gh attestation verify`，限定本仓库、官网打包 workflow、上述源提交和标签；部署使用 CI 原始产物，未以本地重建包替代。
- 沿用受保护的 `npm-production` 环境和 `cli-v*` 标签规则。早期 `cli-web-v1.0.10` 被环境规则拒绝后没有改弱规则；使用合规标签重新构建。该标签触发的 npm 发布任务已取消，不将其描述为 npm 发布成功。

## 正式发布及实测

2026-09-28 14:20（北京时间）发布静态安装页面、版本包和 Nginx 路由。运行目录为 `/var/lib/zhicui-downloads/cli`，无数据库或应用运行时变更。执行 `nginx -t` 后仅 reload Nginx；后端和前端未重启，三个服务均为 active。

Nginx 原配置备份：`/etc/nginx/snippets/zhicui-windows-updates.conf.cli-backup-20260928T142046`。发布脚本 `deploy/publish-cli-website.py` 校验产物目录、版本、来源提交、大小、哈希及当前 Nginx 配置哈希；版本文件拒绝覆盖不同内容，配置测试或 reload 失败会还原 Nginx 备份。

验收结果：

1. 公网指南、CSS、JS 和版本 JSON 均返回 200，Content-Type 正确；静态发行资源为 no-store，指南使用仅同源脚本/样式的 CSP。官网下载安装包哈希与 CI 一致。
2. 使用全新安装目录及 npm 缓存，直接从 `https://luxai.cn/cli.tgz` 安装成功，版本为 1.0.10；无需 npm 账号登录。随后从相同官网地址更新本机全局 CLI。
3. 本机真实 `zhicui connect --json` 返回 READY，configuration_ready / authenticated / cloud_available / mcp_healthy 全为 true，发现 39 个当前授权可用的 MCP 工具。复用已有 Windows DPAPI 凭证，未打印或扩权。再次执行仍 READY，`setup.codex.changed=false`，没有重复改写连接配置。
4. 同一条用户抖音链接 `https://v.douyin.com/fY_wQtEXhHw/` 强制重新解析：服务端 520ms、完整 CLI 命令 1,207ms、缓存未命中、媒体预下载 0 字节。
5. 实际下载完成：命令总耗时 16,600ms，5,450,772 字节，JSONL 终态为 `video.completed / succeeded`。本地文件 `D:/6month/.artifacts/cli-web-download.mp4`，SHA-256 为 `171471ec6bbd0f3c0f9da19b0d04173a3f5646c4199626386538df674ba7ec23`，与此前原视频一致。解析速度与完整文件传输速度分别记录。
6. 公网 `/api/health` 返回 200。浏览器桥接不可用，本次未声称完成安装页的浏览器视觉或点击验收；新授权/拒绝授权的交互协议由真实 CLI 子进程与模拟授权服务的自动测试覆盖。

本地验收日志保存在 `.artifacts/cli-web-*`，不提交账号凭证、临时下载入口或测试视频到仓库。
