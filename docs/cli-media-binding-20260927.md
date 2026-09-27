# CLI 视频读取与网页对齐（2026-09-27）

## 问题与修改

正式 CLI 1.0.4 已发布导入、转写、下载入口，但媒体下载和转写只读取公开来源；网页可使用当前用户已连接的抖音账号。因此同一资料在两种入口的结果可能不同。

- CLI 下载和转写改用与网页相同的 `prepared_user_media`。绑定 scope 只从资料所有者的数据库记录读取，CLI 不可指定其他人的连接，不返回 Cookie 或上游临时地址。
- 保留绑定端 404/410 时一次公开来源恢复；401/403/412/429 不绕过验证、不连续重试。
- 网页和 CLI 共用资料归属、账号可用状态及绑定状态复查。CLI 仍检查 PAT 权限、撤销状态和接口开关；ASR 前及结果保存前复查授权与平台连接。
- 共用每用户 1 个、每进程 4 个媒体任务限制。共用临时文件响应，确保非法 Range、发送中断和正常完成均清理文件并释放并发槽。
- 不改变 core 的 41 个 Action / 11 个 scope，不给旧 PAT 自动增加权限。导入、转写仍需 `library:write`，下载需 `library:read`。

## 验证与发布

真实测试分为旧 PAT 下载与有写入权限的完整素材准备，不能用公开能力发现成功替代实际下载成功。

- 本地专项 41 项通过；后端全量 927 项，926 通过、1 项按环境跳过。
- 覆盖旧公开来源恢复、当前用户绑定、绑定中途撤销、资料删除、PAT 撤销、非法 Range 清理、共享并发限制以及 ASR 完成前撤销绑定时禁止保存。

## 正式环境结果（2026-09-27 09:10，Asia/Shanghai）

- 代码提交 `59aa4844510986356b87b57970663be341e2de0d`。Jenkins 308 dark 发布通过；同备份恢复演练通过，再提升 core。当前 runtime 为 `/opt/zhicui-runtime/releases/manual-single-video-cli-59aa484-20260927T010420`。
- 最终发布 exit code 0。备份、readiness、发行清单、普通用户权限边界、Agent Action/PAT/MCP、真实 AI SSE 问答等必需检查均通过；专用冒烟账号密码租约已恢复、临时明文已删除。
- 线上 `build-version.json` revision 为 `59aa48445109`；公开 capabilities 为启用的 `core`，41 个 Action / 11 个 scope。
- 本机安装的 CLI 1.0.4：原 PAT 验证有效，可见 39 个 Action；资料列表读取成功（总计 51 条）。原 PAT 缺少 `library:write`，导入和转写不可用，未自动增权。
- 原 PAT 下载资料 `f0f804bb-bbe4-40e8-875d-20393517fa0a` 仍返回 `PLATFORM_AUTH_REQUIRED`，未产生 MP4。生产连接器日志确认本次请求到达绑定媒体入口，视频 `7590292725087620709` 返回 404，之后公开来源恢复被平台限制。只读诊断显示绑定 connected、连接器在线、cookie_valid=true，存储模式 metadata_only；这些状态不代表该作品媒体一定可读取。
- 另用专用普通测试账号、临时最小权限 PAT，通过真实 Windows CLI 执行 `library prepare https://v.douyin.com/JUV4bfM5wBU/`。在导入阶段返回 `PLATFORM_AUTH_REQUIRED`（exit 7），因此没有进入转写和下载，完整链路本次**未通过**。未将本地模拟回归或之前的网页成功记录作为本次下载成功证据。
- 完整 CLI 测试后已撤销该临时 PAT、清除本机测试 profile、恢复专用账号密码租约；没有创建资料，也未修改用户现有凭证。

## 尚待完成

- 用户通过设备授权流程授予 `account:read,library:read,library:write`，以便在其自身资料库实测导入和转写；旧 PAT 继续有效。
- 平台恢复该视频读取，或用户在客户端完成平台要求的验证后，再进行一次实际下载和文件校验。当前不能宣称已成功下载或已交给 Hypit。
