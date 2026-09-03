# Changelog

## 1.0.0

- 将云端普通用户能力统一为版本化 Product Action、Run 与事件协议。
- 提供稳定的 JSON/JSONL 输出、退出码、幂等、断线续读与取消语义。
- 提供远程 MCP、本地 stdio MCP，以及 Codex / Claude Code 幂等接入与恢复。
- PAT、设备授权、scope、限流、确认、防重放、审计与秘密脱敏通过 Stable 回归。
- Windows 本机能力仅经签名客户端固定动作开放；不暴露管理端、任意 Shell、数据库或原始秘密。

## 0.1.0-beta.1 security follow-up

- 设备授权默认 scope 收敛为只读权限。
- 本机 Action 使用固定别名、白名单与可信 Schema，本机 run 不再进入云端轮询。
- MCP 拒绝秘密字段并对返回值做递归脱敏。
- 增加本机取消、媒体打开、Schema 漂移与干净打包回归测试。

## 0.1.0-beta.1

- 新增 Node 22 ESM `zhicui` 命令与零运行时依赖发布包。
- 新增浏览器设备授权、无回显 PAT 导入和系统凭据存储抽象。
- 新增 capabilities、Action 调用、Run 查询/续传/取消和 JSON/JSONL 机器协议。
- 新增普通用户命令域别名与受限本机 Windows Action 适配器。
- 新增 MCP stdio 工具发现/调用，以及 Codex、Claude Code 的幂等 setup/doctor/status/update/uninstall。

所有版本均不开放管理端、任意 Shell、数据库、Cookie、JWT、API Key 或内部研究工具；平台同步仍须显式调用。
