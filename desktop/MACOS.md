# 知萃 Mac 开发与构建

现有 Windows 环境可以继续改代码，无需安装 Xcode 或额外软件。真正的 Mac 安装包需要 macOS 构建机；本仓库提供 GitHub Actions 工作流。2026-09-05 已在 macOS runner 成功构建 Apple Silicon 和 Intel 测试包，尚未经过真实设备交互验收，不能当作已发布版本。

首次成功构建：[运行记录与安装包](https://github.com/kyirexy/zhicui/actions/runs/33949358772)，代码提交 `235e0fd1cfc43d6cbf3b4a9e4d740497183e0603`。Artifacts 中的 `zhicui-mac-arm64-test` 适用于 Apple Silicon，`zhicui-mac-x64-test` 适用于 Intel。两项构建的跨平台逻辑检查均通过，签名公证步骤未执行。下载需要登录有访问权限的 GitHub 账号，产物保留 14 天。

## Windows 上开始

首次开发验证推送 `codex/macos-desktop` 分支会自动运行相同测试构建；后续合入默认分支后可通过 Run workflow 手动运行。

已有 Node.js 与 Git 即可。运行 `npm run verify:mac`（desktop 目录）检查路径与发布配置。无需在 Windows 安装虚拟 macOS。

将本次代码提交到 GitHub 后，打开仓库 Actions →「构建知萃 Mac」→ Run workflow。保持 signed 为 false，即可生成无需苹果证书的测试构建。工作流只上传 Actions artifacts，不创建 Release，不修改 luxai.cn 下载站。产物保留 14 天，分别包含 Apple Silicon（arm64）和 Intel（x64）的 DMG/ZIP。

私有仓库可能消耗 Actions 额度或产生费用，请在 GitHub Billing 查看实际可用额度。当前文件仅配置工作流，未替你开通收费服务。

## Mac 上开发

安装 Node.js 22.12+（建议 22.22）、Git；同步抖音或 B站需安装 Chrome 或 Edge。Electron macOS 版不要求完整 Xcode；若依赖或构建工具提示需要编译工具，可运行 `xcode-select --install`。iOS 开发才需要完整 Xcode。

前端和后端按项目常规方式启动，然后：

```bash
cd desktop
npm ci
ZHICUI_DESKTOP_URL=http://127.0.0.1:3000 npm run dev:electron
```

用户界面/后端仍复用已有代码和服务；本机 Agent 描述文件位于 `~/Library/Application Support/Zhicui/desktop-agent-bridge.json`，仅保存在本机，不能分享。

## 手动打包

在 macOS 上执行：

```bash
cd desktop
npm ci
npm run dist:mac -- --arch=arm64
npm run dist:mac -- --arch=x64
```

脚本生成 ICNS 图标、构建内置 CLI 和 Electron，输出到 `release-mac-arm64/` 或 `release-mac-x64/`。测试包仅做临时签名（ad-hoc），没有 Developer ID/公证，可能被 Gatekeeper 拦截，不应面向普通用户分发；自动更新已禁用。

## 签名、公证和正式分发

需要 Apple Developer Program 的 Developer ID Application 证书（不是 iOS 开发证书）。在仓库 Actions Secrets 配置：

- `MAC_CSC_LINK`：导出的 .p12 证书的 Base64 内容。
- `MAC_CSC_KEY_PASSWORD`：证书密码。
- `APPLE_ID`：苹果开发者账号。
- `APPLE_APP_SPECIFIC_PASSWORD`：苹果账号的 App 专用密码。
- `APPLE_TEAM_ID`：开发团队 ID。

启用工作流 signed。缺少凭据会在构建前失败；完成后验证签名、公证票据和 Gatekeeper。脚本本地签名参数为 `--signed`，对应环境变量中的证书名为 `CSC_LINK`、`CSC_KEY_PASSWORD`。

签名公测包的更新源按架构分开：`https://luxai.cn/download/mac/arm64/` 与 `https://luxai.cn/download/mac/x64/`。更新站点当前不会由本工作流发布，需要验收后将各目录 DMG、ZIP、blockmap 与 `beta-mac.yml` 一并部署；请勿复制 Windows 的 beta.yml。默认渠道仍是 beta，不冒充稳定版。

## Mac 验收记录（待执行）

- Intel 和 Apple Silicon 分别安装、启动与退出。
- Command+C/V、撤销、全屏；关闭窗口后 Dock 重开。
- 账号登录、协议链接冷启动；手机扫电脑登录手机的反向授权需求仍属另一个登录变更，不能用现有登录电脑流程代替。
- Chrome/Edge 登录抖音和 B站；收藏/喜欢/作品与来源真实一致。
- AI 问答、知识、计划和内置 CLI 用户隔离。
- 下载到选定目录、Finder 定位、取消和重试。
- 签名包 Gatekeeper、公证与跨版本更新验证。

Mac 依赖的 B站目录 sidecar 目前只有 Windows 启动脚本，涉及该可选连接器的功能需单独验收和配置；已内置的浏览器账号采集仍复用 Playwright。
