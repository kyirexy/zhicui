## Context

知萃后端已经通过 `DOUYIN_DOWNLOADER_URL` 访问一个可选的 `douyin-downloader` HTTP 服务，本地实际运行的是基于上游提交 `c8ddfeb` 的改造版。该服务持有 Cookie、媒体文件、manifest 和收藏顺序；知萃只保存用户主动生成的文案、知识卡和计划。

生产服务器当前只运行知萃 FastAPI、Next.js、Nginx 和 PostgreSQL。服务器无图形桌面，因此本地 `Playwright launch(headless=False)` 的扫码流程无法直接复用。生产磁盘还有足够空间保存本地约 5.5 GB 的伴随媒体库。

## Goals / Non-Goals

**Goals:**

- 生产环境稳定运行与本地相同的改造版下载器 API。
- 保持端口仅本机可达、Cookie 最小权限保存、视频不进入知萃数据库。
- 让无桌面服务器生成可在知萃 Web/Capacitor 页面扫码的二维码。
- 首次部署同步本地 manifest、收藏顺序、封面和视频文件。
- 让安装过程可重复执行并可通过 systemd、健康检查和日志验证。

**Non-Goals:**

- 不把伴随服务端口直接暴露到公网。
- 不把 Cookie、视频二进制或下载器数据库写入知萃 PostgreSQL。
- 不在本次变更中实现对象存储、CDN、分布式队列或多账号 Cookie 隔离。
- 不承诺绕过抖音风控；登录和采集仍受抖音接口可见性限制。

## Decisions

### 1. Pinned upstream plus a tracked Zhicui patch

生产安装脚本从固定上游提交 `c8ddfeb` 创建新 release，并应用仓库内的 Zhicui patch。选择补丁而不是复制整个参考仓库，保留上游许可证和来源边界，也让本地改造能够审查和重建。每次安装创建新 release，再切换 `current` 符号链接，避免对正在运行的目录做破坏性重置。

### 2. Loopback-only systemd sidecar

服务使用独立 venv、`ubuntu` 服务账号和 systemd，绑定 `127.0.0.1:9000`。知萃后端继续通过默认地址访问；Nginx 不增加 9000 代理。Cookie 位于 `/opt/douyin-downloader/.cookies.json` 且权限为 `0600`，媒体位于 `/opt/douyin-downloader/Downloaded`。

### 3. Virtual-display QR capture with an in-memory image

真实验证表明抖音会把纯无头 Chromium 导向人机验证，而标准可见 Chromium 能正常生成二维码。生产 unit 因此通过 Xvfb 提供私有虚拟显示，Playwright 继续使用 `headless=False`；本地仍显示普通浏览器窗口。登录任务自动展开登录入口，优先寻找 DOM 二维码；对于 closed shadow root，再用 OpenCV 从当前视口截图中定位并裁剪可解码 QR，只把裁剪 PNG 保存在内存，不保存或返回整页截图。状态协议只返回 `qr_ready` 和递增 `qr_version`，二进制图片由单独 endpoint 返回。

知萃后端使用受 JWT 保护的代理 endpoint 读取二维码 PNG，并以 JSON data URL 返回给客户端。浏览器永远不能直接访问伴随服务，也不会收到 Cookie 值。

### 4. Inline responsive QR card

视频库登录区在扫码进行中显示二维码卡片、状态文本和“关闭”操作。二维码使用固定正方形容器和普通 `<img>`，不添加循环动效；手机端随内容宽度缩放，保留安全区和可读提示。二维码版本变化时才重新获取图片，并在任务结束时清理状态。

### 5. Direct media migration outside the database

本地 `Downloaded/` 通过 SSH 复制到生产媒体目录，包括 `download_manifest.jsonl` 和 `source_order.json`。复制完成后比较文件数、总字节数、manifest 行数和抽样媒体可访问性。迁移过程不调用知萃数据库。

## Risks / Trade-offs

- [抖音页面 DOM 变化导致找不到二维码] → 使用多组语义 selector 和几何候选，并把失败原因展示在登录区；现有 Cookie 仍可继续使用。
- [二维码过期] → 登录任务轮询期间定期重截图并递增版本，前端按版本刷新。
- [Cookie 被伴随 API 泄露] → 9000 仅监听 loopback；知萃代理只返回 valid/count/status/QR，不转发 Cookie 字段。
- [5.5 GB 初次传输耗时] → 先部署服务和 manifest，再持续同步媒体；最终按计数与字节校验后才宣告一致。
- [磁盘持续增长] → 本次保留现有有界同步数量；后续再设计清理策略和对象存储。
- [Playwright、Xvfb 和 OpenCV 依赖较大] → 浏览器缓存与 venv 放在伴随服务持久目录，由安装脚本一次安装并在 release 之间复用。

## Migration Plan

1. 实现并测试二维码协议、知萃代理和响应式二维码 UI。
2. 生成固定上游提交的 Zhicui patch，添加安装脚本和 systemd unit。
3. 服务器安装 Playwright Chromium、创建 venv、安装 release 并启动 loopback 服务。
4. 通过 SSH 安全复制当前 Cookie 配置和本地 `Downloaded/`。
5. 验证伴随服务健康、登录状态、条目顺序、媒体访问和知萃线上连接状态。
6. 构建前端、Capacitor 和 APK，提交并触发 Jenkins 部署。

回滚时停止并禁用 `zhicui-douyin-sidecar`，知萃自动回到“连接器未连接”状态；单条提取、知识库和计划不受影响。

## Open Questions

无阻塞问题。媒体清理周期与对象存储迁移留待实际增长数据后决定。
