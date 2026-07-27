## Context

知萃后端已经通过 `DOUYIN_DOWNLOADER_URL` 访问一个可选的 `douyin-downloader` HTTP 服务，本地实际运行的是基于上游提交 `c8ddfeb` 的改造版。生产服务只持有 Cookie、最近 50/100 条资料库元数据和收藏顺序；知萃只保存用户主动生成的文案、知识卡和计划。

生产服务器当前只运行知萃 FastAPI、Next.js、Nginx 和 PostgreSQL。服务器无图形桌面，因此本地 `Playwright launch(headless=False)` 的扫码流程无法直接复用。生产服务器不得把视频文件作为资料库资产保存。

## Goals / Non-Goals

**Goals:**

- 生产环境稳定运行与本地相同的改造版下载器 API。
- 保持端口仅本机可达、Cookie 最小权限保存、视频不进入数据库或持久目录。
- 让无桌面服务器生成可在知萃 Web/Capacitor 页面扫码的二维码。
- 用户明确选择同步最近 50 或 100 条，最大 100 条。
- 仅同步元数据；播放与 ASR 按需临时拉流并在完成后清理。
- 让安装过程可重复执行并可通过 systemd、健康检查和日志验证。

**Non-Goals:**

- 不把伴随服务端口直接暴露到公网。
- 不把 Cookie、视频二进制或下载器数据库写入知萃 PostgreSQL。
- 不在生产服务器的伴随目录持久化视频或音频。
- 不在本次变更中实现对象存储、CDN、分布式队列或多账号 Cookie 隔离。
- 不承诺绕过抖音风控；登录和采集仍受抖音接口可见性限制。

## Decisions

### 1. Pinned upstream plus a tracked Zhicui patch

生产安装脚本从固定上游提交 `c8ddfeb` 创建新 release，并应用仓库内的 Zhicui patch。选择补丁而不是复制整个参考仓库，保留上游许可证和来源边界，也让本地改造能够审查和重建。每次安装创建新 release，再切换 `current` 符号链接，避免对正在运行的目录做破坏性重置。

### 2. Loopback-only systemd sidecar

服务使用独立 venv、`ubuntu` 服务账号和 systemd，绑定 `127.0.0.1:9000`。知萃后端继续通过默认地址访问；Nginx 不增加 9000 代理。Cookie 位于 `/opt/douyin-downloader/.cookies.json` 且权限为 `0600`，有界资料库元数据位于 `/opt/douyin-downloader/Metadata`。

### 3. Virtual-display QR capture with an in-memory image

真实验证表明抖音会把纯无头 Chromium 导向人机验证，而标准可见 Chromium 能正常生成二维码。生产 unit 因此通过 Xvfb 提供私有虚拟显示，Playwright 继续使用 `headless=False`；本地仍显示普通浏览器窗口。登录任务自动展开登录入口，优先寻找 DOM 二维码；对于 closed shadow root，再用 OpenCV 从当前视口截图中定位并裁剪可解码 QR，只把裁剪 PNG 保存在内存，不保存或返回整页截图。状态协议只返回 `qr_ready` 和递增 `qr_version`，二进制图片由单独 endpoint 返回。

知萃后端使用受 JWT 保护的代理 endpoint 读取二维码 PNG，并以 JSON data URL 返回给客户端。浏览器永远不能直接访问伴随服务，也不会收到 Cookie 值。

### 4. Inline responsive QR card

视频库登录区在扫码进行中显示二维码卡片、状态文本和“关闭”操作。二维码使用固定正方形容器和普通 `<img>`，不添加循环动效；手机端随内容宽度缩放，保留安全区和可读提示。二维码版本变化时才重新获取图片，并在任务结束时清理状态。

### 5. Bounded metadata synchronization and ephemeral media

同步接口只接受 50 或 100 条，并为每个来源原子替换当前快照，避免历史合并导致无限增长。生产 `metadata_only` 模式禁用 `/download` 与 `/crawl`，不挂载持久媒体目录。播放通过短时签名的双层流式代理完成；ASR 写入独立临时目录并在 `finally` 清理。安装器还会清除旧版本遗留的媒体扩展名文件。

## Risks / Trade-offs

- [抖音页面 DOM 变化导致找不到二维码] → 使用多组语义 selector 和几何候选，并把失败原因展示在登录区；现有 Cookie 仍可继续使用。
- [二维码过期] → 登录任务轮询期间定期重截图并递增版本，前端按版本刷新。
- [Cookie 被伴随 API 泄露] → 9000 仅监听 loopback；知萃代理只返回 valid/count/status/QR，不转发 Cookie 字段。
- [视频流占用带宽] → 只在用户播放或生成文案时拉流；不做持久缓存。
- [临时任务异常遗留] → ASR 使用唯一临时目录并在 `finally` 递归清理，失败路径同样执行。
- [Playwright、Xvfb 和 OpenCV 依赖较大] → 浏览器缓存与 venv 放在伴随服务持久目录，由安装脚本一次安装并在 release 之间复用。

## Migration Plan

1. 实现并测试二维码协议、知萃代理和响应式二维码 UI。
2. 生成固定上游提交的 Zhicui patch，添加安装脚本和 systemd unit。
3. 服务器安装 Playwright Chromium、创建 venv、安装 release 并启动 loopback 服务。
4. 通过 SSH 安全复制当前 Cookie 配置，不复制本地视频。
5. 验证伴随服务健康、登录状态、50/100 上限、条目顺序、即时流和服务器媒体文件数为零。
6. 构建前端、Capacitor 和 APK，提交并触发 Jenkins 部署。

回滚时停止并禁用 `zhicui-douyin-sidecar`，知萃自动回到“连接器未连接”状态；单条提取、知识库和计划不受影响。

## Open Questions

无阻塞问题。
