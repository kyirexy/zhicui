## Why

知萃的核心视频资料、AI 问答与计划链路已经可用，但公开推广所需的隐私权利、数据恢复、运行告警、可信客户端签名、真实连接器健康和窄屏官网体验仍未闭环。现在需要把“可演示的公测产品”升级为可持续运营、可审计、可安全分发的正式发布基线。

## What Changes

- 新增隐私政策、用户协议、注册明确同意、个人数据导出与账号注销/云端数据删除闭环。
- 新增 PostgreSQL 自动加密备份、保留/恢复验证、深度健康检查、主动告警、认证限流与生产安全头。
- 将抖音/B站连接器健康从管理员手工标志改为真实运行探测；未运行的 yutto 不得显示健康，并提供可审计的数据回填/清理任务。
- 清理历史缺封面、缺作者、占位标题和过短文稿，避免坏资料继续出现在资料库与宣传账号。
- 修复官网窄屏横向溢出，统一 Web、Windows 与 Android 的登录、法律入口、错误提示和降级说明。
- 建立 Windows 代码签名与 Android Release keystore 的正式发行契约；缺少外部可信证书时构建必须明确失败或标记为内测，禁止把未签名/Debug 包标成正式版。
- 增加真实浏览器、连接器冒烟、恢复演练和小并发容量验证，并将结果纳入部署闸门。

## Capabilities

### New Capabilities

- `privacy-account-controls`: 隐私/协议展示与同意、数据导出、账号注销和全量用户数据删除。
- `production-resilience-observability`: 自动备份与恢复校验、深度健康、主动告警、限流、安全头和发布容量基线。
- `trusted-client-release`: Windows 与 Android 正式签名、版本清单、更新校验和内测/正式渠道隔离。
- `public-release-experience`: 官网窄屏自适应、客户端下载说明、平台降级声明及用户可发现的法律/支持入口。

### Modified Capabilities

- `creator-catalog-connectors`: 健康状态必须来自真实 sidecar/降级能力探测，目录字段质量和回填状态必须可见。
- `production-deploy-safety`: 部署前后增加备份、恢复、深度健康、客户端发行物与关键用户旅程闸门。
- `client-update-delivery`: Windows 更新清单必须区分可信签名正式包与未签名内测包。
- `mobile-app-updates`: Android 更新只接受固定 Release 身份签名的正式包，Debug 包不得发布到正式更新通道。

## Impact

- 后端：认证/用户 API、数据删除与导出服务、健康/告警/限流中间件、连接器状态、回填任务、数据库模型和迁移。
- 前端：注册登录、设置、法律页面、账号数据控制、官网响应式布局、客户端更新和平台降级文案。
- 运维：PostgreSQL 备份/恢复脚本与 systemd timer、Nginx 安全头、sidecar 单元、部署闸门和冒烟脚本。
- 客户端：Electron 签名配置、Android Release signingConfig、版本清单与构建脚本。
- 生产：需要真实签名证书/密钥等外部凭据；仓库只保存配置契约与不含密钥的自动化。
