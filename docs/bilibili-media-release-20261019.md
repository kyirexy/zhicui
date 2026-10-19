# B站媒体备用地址与资料库关联修复

状态：发布前准备完成，等待冻结提交。目标 Web 版本 **1.1.23**；本文不代表已部署。

## 本次修复

- B站媒体主地址不可安全使用时，按有界候选列表尝试平台提供的备用地址；每个候选继续经过既有主机、地址、重定向、大小和超时校验，不放宽媒体安全限制。
- 成功提取语音文稿后，将 Note 关联到同一用户、同一 BVID、同用户 B站博主下已有的可用目录条目。只有已验证的非空语音文稿才显示已导入；保留删除、不可用、质量隔离和已有其他文稿关联，不创建博主、不改同步 run 计数、不重复调用 ASR。
- 修正 Agent `library.list` 隐藏尚未生成 AI 卡片的导入资料的问题。当前账号的待转写和已转写资料均可见，分页与搜索一致；列表不返回完整文稿，原知识卡片列表继续使用原筛选。
- 不增加 core Action、scope 或平台写权限；不重发 CLI、Windows 或 Android 二进制。

## 发布前验收

- 根代理已完成两组后端回归：93 + 62 = **155 项通过**，退出码均为 0；`git diff --check` 通过。
- 第一组：`tests.test_agent_library_visibility`、`tests.test_agent_link_media`、`tests.test_bilibili_public_pipeline`、`tests.test_creator_note_link_service`、`tests.test_agent_interface_routes`。
- 第二组：`tests.test_agent_core_profile`、`tests.test_agent_creator_catalog_import`、`tests.test_platform_library_import`。
- 使用既有 Python 环境，`PYTHONUTF8=1`、`DOUYIN_MCP_SERVER_ROOT=D:/6month/douyin-mcp-server`。初次缺少该依赖路径导致模块导入失败，补齐环境后全部通过。
- 关联 helper 的 11 项测试包含条目与博主双层账号隔离、平台和 BVID 对应、未完成文稿拒绝、重复关联、删除与隔离保护、同步计数不变，以及文稿和关联一同回滚。

本次真实批次在修复前已结束：20 条已导入资料库，9 条文稿就绪，10 条返回 `UNSAFE_MEDIA_TARGET`，1 条返回 `PLATFORM_UNAVAILABLE`。发布前没有该批次正在执行的 Agent 调用。这里只记录汇总，不保存用户文稿、Cookie 或凭据；这些数字不代表修复后的成功数量。

## 生产基线与执行顺序

2026-10-19 22:16（Asia/Shanghai）只读确认：

- runtime 为 `/opt/zhicui-runtime/releases/manual-creator-core-adb60c4`，Git SHA 与远端 master 均为 `adb60c4e2fe5301f1098066e36599d96e4e800c1`。
- Jenkins 最近构建 #326 成功，无运行中的部署、无队列项、无活动 smoke 密码租约；runtime 所在磁盘可用约 8293 MiB。
- 无凭据公网基线 10 项检查全部通过：Web 1.1.22、健康和 readiness、core 精确清单、日常七项 scope、已开放与排除能力、已有 CLI/Windows 清单。

提交冻结后，使用现有 [发布闸门](../deploy/RELEASE-RUNBOOK.md) 与 [core 发布规则](../deploy/AGENT-INTERFACE-CORE.md)：

1. 重新确认 Jenkins 无并发部署、远端及 runtime 基线未变，再推送冻结提交；由 Jenkins 进行同 SHA dark 发布。
2. 确认 dark 构建及 root-owned 哈希证据成功，使用该证据绑定的加密归档执行隔离 PostgreSQL 双启动恢复演练，不启动 worker，并清理隔离资源。
3. 仅通过既有 `smoke-password-lease.py` 获取临时冒烟租约，由已准备的 `release-core.py` 执行同 SHA core 晋级；认证、SSE、PAT/MCP、权限拒绝、吊销及备份闸门均保留，完成或失败均恢复租约。
4. 回读最终 runtime、root-owned dark/core/rehearsal 哈希证据、独立 core 开关及无凭据公网版本/清单。门禁失败按现有脚本恢复 dark 并回滚，不绕过失败项。
5. 发布完成后主任务使用公开 Agent 能力继续用户已授权的剩余作品；发布冒烟只使用固定非管理员隔离账号，不读取真实用户资料。

非秘密执行器与基线证据保存在 `.artifacts/bilibili-media-release/`。最终提交、构建号、恢复演练和发布结果由完成后的 `RELEASE-RESULT.md` 记录。
