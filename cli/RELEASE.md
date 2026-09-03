# CLI Stable 发布说明

CLI 与服务端 Agent v1 必须通过生产门禁后一起发布。源码和 npm 包均不得包含 npm token、PAT、桌面桥令牌、签名证书或用户配置备份。

## npm Stable

正式包只从 GitHub Actions 的 `Publish Zhicui CLI Stable` 环境发布：审核并推送与
`cli/package.json` 完全一致的不可变标签（例如 `cli-v1.0.0`），流水线会验证该提交属于
`origin/master`、执行完整测试和包内容审计、使用 GitHub OIDC 生成 npm provenance，最后
从 npm 官方仓库回读版本、`latest` 标签和产物完整性。禁止从开发机手工发布 Stable。

首次创建 `@zhicui/cli` 时，可在受保护的 `npm-production` GitHub Environment 中临时配置
最小权限 `NPM_TOKEN`；创建 npm trusted publisher 后应删除该 secret，后续只使用 OIDC。
仓库和命令行参数中都不得出现 token。

发布身份由 npm trusted publishing 或仅发布环境可读的凭据注入；仓库不保存 `.npmrc`。发布 `latest` 前必须在干净临时目录完成包内容审计，并针对当前 Codex 与 Claude Code 真实版本验证安装、重复安装、MCP 工具发现、调用、卸载和配置恢复。

## Windows Stable

桌面构建复制 `cli/dist/` 和 `cli/skills/` 到安装目录的固定 `resources/cli/`。Electron 主进程只允许执行固定形式：

```text
ELECTRON_RUN_AS_NODE=1 <desktop-executable> <resources/cli/index.js> agent <setup|doctor|status|update|uninstall> --client <codex|claude|all> --json --non-interactive
```

Renderer 不得传入可执行文件、路径、环境变量或任意 argv。Windows CLI 与安装包必须由发布流水线生成，完成 Authenticode、可信时间戳、发布者匹配、安装/更新/回滚验证后，Stable 清单才可标记为 `available`。

## 上线与回滚

1. 先以 `AGENT_RELEASE_MODE=dark` 暗发布并在接口关闭时建立持久化表。
2. 再使用独立 Agent pepper、空白名单和 `AGENT_RELEASE_MODE=stable` 全量上线。
3. 运行 PAT/Action/Run/事件/MCP/吊销及既有 Web、AI SSE、客户端下载冒烟。
4. 任一门禁失败时关闭接口并吊销相关凭据；CLI 将 `INTERFACE_DISABLED` 作为稳定远端错误返回。
