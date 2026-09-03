# @zhicui/cli

知萃普通用户能力的 Node 22 CLI 与本地 MCP 入口。它只调用版本化 Action 接口，不包含管理端、数据库、任意 Shell、Cookie、JWT、API Key 或内部视频研究工具。

```bash
npx @zhicui/cli auth login
npx @zhicui/cli library list --json
echo '{"source_ids":["..."]}' | npx @zhicui/cli ask start --jsonl --non-interactive
npx @zhicui/cli mcp serve --stdio
```

设备授权默认只申请普通用户的只读 scope；需要导入、同步、提问或修改计划时，
请在授权中心明确增选对应写入 scope，CLI 不会自行扩权。

Windows 客户端运行时可调用固定本机动作：

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

环境变量：

- 正式 CLI 固定连接 `https://luxai.cn`。仓库开发测试可显式设置 `ZHICUI_CLI_DEV=1` 与本机回环 `ZHICUI_API_URL`；凭据按服务来源隔离，不能跨来源复用。
- `ZHICUI_PROFILE`：本机凭据配置名，默认 `default`。
- `ZHICUI_CONFIG_HOME`：CLI 非秘密配置目录。
- `ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS=1`：系统凭据库不可用时，明确允许退回权限为 0600 的用户配置文件；默认拒绝该降级。
- `ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR`：受信桌面桥描述文件位置；不接受远端地址。

发布包不包含凭据。npm 正式发布与 Windows Authenticode 由发布流水线注入身份，源码不保存发布令牌或证书。
