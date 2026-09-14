# B 站导入 502 与重复发布重启核查

## 已确认的线上事实

2026-09-14 的 Jenkins 239 发布在正式切换 runtime 前，无条件重启了一次旧后端。全部时间为北京时间：

| 时间 | 只读证据 |
| --- | --- |
| 18:31:34.946 | sudo 日志：`jenkins` 执行 `systemctl restart videocapsule-backend`。 |
| 18:31:35.133 | uvicorn 等待现有连接关闭。 |
| 18:33:05.139 | systemd 的停止等待超时，随后向 PID 743425 发送 SIGKILL。 |
| 18:33:05 | Nginx 记录 `POST /api/library/imports` 502，原因是 `upstream prematurely closed connection`；同秒 GET 导入列表连接后端失败。 |
| 18:33:15 | 旧 runtime 的后端重新启动。 |
| 18:38:10–18:38:23 | 正式切换到 release 239，后端第二次停止并启动，本次正常关闭。 |

18:31:40–18:33:10 期间其他多个 API 也返回 502，因此当时并非只有 B 站接口受影响。18:00 之后已检索的内核日志没有 OOM 事件，后端日志没有 Python 异常类型或应用异常栈证据；该 POST 的错误是上游连接被关闭，不是 Nginx 的读取超时报错。

20:42 复验：health 200 / ok、readiness 200 / ready，后端、前端、Nginx 均 active，Agent capabilities 仍为 503 / `INTERFACE_DISABLED`。不需要紧急重启当前服务。

SQL 精确核对 `luxai_admin` 后，未查到该账号的 B 站 `library_sync_runs` 记录。此结果不能证明每一条视频均未保存；它只说明没有可用的 B 站同步 run 记录。私有视频正文、完整列表、凭据均未导出。

## 发布脚本修复

`deploy/deploy.sh` 在 dark 前置阶段及切换前失败收尾阶段共同执行三项检查：

1. 由既有受限 root helper 执行 `verify-dark`，检查状态文件为普通文件、root 所有、0600、只有一项有效的 false 配置。
2. 本机后端 `/api/health` 请求成功。
3. 本机 Agent capabilities 严格返回 503 和 `INTERFACE_DISABLED`。

三项全部通过时，保持旧服务运行，记录 `agent_kill_switch_preflight` 闸门成功及“无需前置重启”。文件关闭但运行态仍启用、接口不可达、无效响应或文件校验失败，仍按原流程写入 dark、重启并检查健康和关闭状态。旧版本 404 仅允许用于修复后的兼容复验，不能作为跳过重启的依据。

同时让 `set_agent_kill_switch` 的写入失败立即返回失败，防止在 Bash 条件调用中被随后成功的 verify 掩盖。备份、schema、Stable 同提交晋级、目标与最终运行态检查以及真正的 runtime 切换/回滚重启保持原有行为。无需修改 systemd、sudoers 或安装新的运维 helper。

这会消除正常 dark 发布的第一次停止；正式新版本切换仍需停止旧进程。长时间下载或 ASR 不应依赖一个同步 HTTP 请求存活到整批结束，持久后台任务及中断恢复由同批应用修复处理。

## 验证与证据

```powershell
cd D:/6month-worktrees/douyin-sync-flow-20260914/backend
& D:/6month/backend/.venv/Scripts/python.exe -m unittest tests.test_deploy_dark_preflight tests.test_agent_release_kill_switch tests.test_agent_schema_release_gate tests.test_release_reproducibility -v
```

50 项通过，其中 17 项执行真实部署 Bash 函数与 dark / Stable 前置分支，只替换 sudo、curl 等系统边界。覆盖健康关闭不重启、开启/404/网络失败/坏响应必须修复、写入/验证/重启/健康/关闭复验失败不得通过、构建失败收尾及 Stable 原有要求。`bash -n deploy/deploy.sh` 与 `git diff --check` 通过。

本地只读证据目录：`D:/6month/.codex-artifacts/bilibili-sync-502-20260914/`。关键文件：`production-restart-timeline.json`、`restart-attribution.json`、`production-safe-logs.json`、`production-bili-sync-records.json`、`current-health.json`。补丁测试没有访问生产；线上日志/状态查询没有修改服务或数据。本记录完成时补丁尚未部署。
