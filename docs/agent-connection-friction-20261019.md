# Agent 接入授权体验修复（2026-10-19）

状态：用户已授权发布；在基于线上 `139cf640627311eb6515e03f1d98241560a83ab4` 的隔离工作树准备 Web 1.1.20、CLI 1.0.20、Windows Beta 1.1.22，实际发布结果待本轮完成后记录。

## 问题与行为变化

实际视频整理流程中，网页新建 PAT 默认只有 `library:read`，CLI 基础连接又未覆盖导入和转写权限；桌面端 core 白名单还拒绝服务端已经开放的 `library:write`、`local:invoke`。PAT 未保存权限元数据，状态检查把“未知”显示成空列表，容易引导重复授权。浏览器与桌面会话彼此独立，造成已登录桌面后还要再登录浏览器。

现在网页 PAT、网页连接提示、CLI 默认登录/一键连接、桌面新连接统一推荐以下日常范围，并与服务发布目录取交集：

`account:read,library:read,library:write,creator:read,ask:read,ask:run,local:invoke`

- 新连接一次确认日常视频导入、转写、下载和问答所需权限；网页保留只读与自定义选项，空选择不会回落成日常默认。
- CLI 检查服务端实际授权；权限足够直接复用，不生成授权码。`--force` 明确重新连接或切换账号，`--scopes` 保留指定范围。
- 新版桌面在已登录、连接就绪且服务来源一致时，承接固定深链接到同一客户端授权页面。仍预览请求方、当前账号与权限，由本人允许；未增加自动审批接口。旧版或打开失败使用同一次请求的网页链接。
- 默认等待服务授权有效期，最多十分钟；明确 `--timeout` 可缩短。授权轮询遇到短暂网络断开继续等待原请求，协议错误仍停止。
- capabilities 新增 `granted_scopes`：认证时返回实际授予且当前发布范围内的权限，匿名为 `null`。原 `scopes` 继续表示权限目录。旧服务按已授权动作只推导已知下界；缺省设备权限不伪装成已确认的请求范围。
- 原有凭据保持原权限；缺权限时确认新设备连接后才替换当前本机 profile。退出、切换账号或取消时，原先等待的授权不能覆盖之后的决定。
- 发布前追加修复 Agent 刷新响应丢失后超过十分钟无法恢复的问题。加密回执只保留当前后继，存活至本次刷新会话有效期；迟到恢复重新签发有效访问凭证，不再次轮换刷新凭证、不延长会话、不增加权限。主动撤销、账号禁用、密码重置和错误请求重放仍被拒绝。
- 正常设备连接持续使用会滑动续期，保留 30 天不活动与 365 天绝对上限。PAT 自身为固定有效期，不支持刷新；希望长期复用应使用默认设备连接。不会将固定有效期 PAT 伪装成永久登录。

## 代码入口

| 部分 | 主要文件 |
| --- | --- |
| 网页预设与创建 | `frontend/src/lib/agentQuickConnect.ts`、`AgentAccessSettingsCard.tsx`、`AgentQuickConnect.tsx` |
| 已登录授权确认 | `frontend/src/components/AgentDeviceAuthorizationCard.tsx` |
| CLI 连接与权限状态 | `cli/src/connection-policy.ts`、`main.ts`、`api-client.ts`、`credentials.ts`、`local-adapter.ts` |
| 桌面承接 | `desktop/src/security.ts`、`main.ts`、`agent-integration.ts`、`agent-action-bridge.ts` |
| 实际授权查询 | `backend/app/api/agent_interface_routes.py` |

## 验证

测试均使用临时凭据、假服务或隔离测试数据库；没有将真实令牌写入测试或日志。

- 后端 Agent grants/routes/core、刷新回执、密码重置与 Web 刷新共 6 套 87 项通过，包括新增 11 项长期丢包恢复与撤销边界；只读 PAT 查询自身权限后，HTTP/MCP 写入仍拒绝且不创建任务。
- 前端相关 helper/契约测试：35 项通过；TypeScript 检查通过。
- 桌面 `npm run verify:agent-integration` 与 `node scripts/verify-sync-bridge.mjs` 通过，含构建、同源固定路由、恶意参数拒绝与桥接响应。
- CLI TypeScript 构建通过，最终全量 `node --test test/*.test.mjs`：201/201 通过。覆盖默认发布范围交集、授权复用、只读补齐、强制重连、网络中断后同一请求恢复、未知权限元数据及并发退出/登录保护。最终日志：`.artifacts/agent-connection-cli-final-20261019.log`。
- 真实 Chrome 验收：`frontend/scripts/verify-agent-quick-connect.mjs` 共 10/10 场景通过，页面错误为空。覆盖 full/core 目录下两处预设选择同步、checkbox、CLI 命令、实际 PAT POST 范围、空选拦截、重新勾选或切回预设后清除空选错误、已有只读凭据不变、取消后重新连接。报告：`.codex-artifacts/agent-permissions-20261019/browser-report.json`。
- 首次 CLI 全量中已有模型密钥更新测试曾返回 code 7（200/201）；原断言只打印 stderr，未保存其 JSON 错误。增强断言后，该文件单跑及并行复测 20/20、最终全量 201/201 通过。没有复现根因，保留首次日志 `.artifacts/agent-connection-cli-tests-20261019.log` 供后续排查，未更改模型密钥业务实现。
- 修改范围 `git diff --check` 通过。

## 发布与限制

隔离目录为 `D:/6month-release-agent-20261019`，保留线上已发布的会话撤销、媒体、计划和 Studio 修复；不带入原工作区未完成的 video_intake、Jenkins 或部署策略变更。CLI 1.0.20 同时包含已完成本地验收的 1.0.19 诊断、按批下载与会话绑定改进，官网和桌面此前仍为 1.0.18。

完整体验需要后端/网页、CLI 和桌面配套更新：先发布兼容新增字段的后端与网页，再发布 CLI 和内置新版 CLI 的桌面包。旧桌面保持网页回退；旧后端的权限推导会明确标为不完整。当前已安装客户端与旧只读 PAT 不因本地代码变更而改变。

此修复不解锁服务尚未发布的博主批量同步能力，也不绕过 B站平台验证。此前目标博主的 20 个视频没有在本次代码修复中导入，不能将代码测试通过当作客户端已有这 20 条资料。
