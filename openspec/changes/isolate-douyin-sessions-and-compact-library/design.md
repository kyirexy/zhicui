## Context

知萃后端已经用 JWT 区分用户，但抖音 sidecar 仍只有一个 `_ServerDeps`：一份 `.cookies.json`、一份二维码内存状态、一份作品目录和一组任务。因此现有鉴权只能保护 API 入口，不能隔离入口后面的真实抖音账号状态。生产 sidecar 只监听 `127.0.0.1:9000` 并使用元数据模式，知萃数据库不得保存视频。

移动端是 Capacitor 静态 Web 应用。抖音 App 不会把自己的登录 Cookie 直接交给知萃 WebView；可行的同机路径是把服务端浏览器生成的二维码保存或分享到系统相册，打开抖音后使用扫一扫从相册识别，再返回知萃继续轮询。

## Goals / Non-Goals

**Goals:**

- Cookie、二维码、同步目录、任务和即时媒体读取都按知萃用户隔离。
- 数据库具有可审计的绑定状态字段，但不保存明文 Cookie 或视频内容。
- 移动端能在同一台设备上完成扫码绑定，并清楚知道每一步。
- 删除视频库首屏的大宣传区，使来源与视频更早出现。
- 本地参考项目与生产 sidecar 补丁保持一致。

**Non-Goals:**

- 不绕过抖音登录、安全策略或验证码。
- 不承诺通过深链直接取得抖音 App Cookie。
- 不把抖音视频下载到知萃数据库或生产磁盘。
- 不迁移旧的全局 Cookie 给任意一个现有用户。

## Decisions

### 1. 使用独立绑定表，不把 Cookie 字段加到 users

新增 `douyin_account_bindings`，一名知萃用户最多一条记录。字段包括 `user_id`、随机 `session_scope`、状态、Cookie 数量、绑定/验证/同步时间和创建更新时间。`session_scope` 使用安全随机值且唯一。

选择独立表是因为抖音绑定是可选的外部账号连接，生命周期与登录用户不同；它也避免 users 表不断累积第三方平台字段。数据库不保存 Cookie 明文或密文，降低数据库泄露后的外部账号风险。

### 2. sidecar 使用不透明作用域隔离全部可变状态

知萃后端在每个 sidecar 请求中发送 `X-Zhicui-Scope`。sidecar 只接受固定长度、受限字符集的作用域，并为每个作用域懒加载会话对象：

- Cookie：`sessions/<scope>/cookies.json`
- 元数据目录、作品目录与来源顺序：`sessions/<scope>/library/`
- 扫码状态与二维码图片：各会话独立保存在内存
- 同步任务：任务记录保存 scope，查询时必须匹配

限速器、重试器和进程级队列仍可共享，因为它们不含用户数据。相比只给 Cookie 分文件，此方案还能阻止用户看到另一账号的作品快照和任务状态。

### 3. 媒体代理签名绑定用户作用域

作品列表生成的短期媒体 URL 将 scope 纳入 HMAC 载荷和查询参数。知萃媒体代理验证签名后，用同一 scope 请求 sidecar。这样 `<video>` 无需暴露 JWT，同时不能把某用户作品 ID 替换后访问另一会话。

### 4. 绑定状态由后端同步更新

路由先通过数据库服务获取或创建当前用户的 scope，再调用 sidecar。状态检查、扫码成功、退出与同步启动后更新安全元数据。sidecar Cookie 数量仅用于状态展示，不返回 Cookie 名称和值给前端。

### 5. 移动端采用原生相册写入、App 启动与浏览器降级

二维码面板提供“保存二维码”和“打开抖音”两个操作。Capacitor Android App 通过受限原生桥接把 PNG 写入系统相册，并使用抖音包名启动已安装 App；Android 9 及以下仅在保存时申请旧版外部存储权限。普通浏览器继续优先使用 Web Share API 分享 PNG 文件，回退为浏览器下载和安全网页入口，并明确说明能力限制。

App 监听前后台切换。用户从抖音返回知萃后立即检查当前扫码任务与 Cookie 状态；即使 WebView 计时器在后台暂停，也会恢复二维码、轮询或登录完成状态。若 App 进程被系统回收，重新进入视频库时也会探测仍在 sidecar 中运行的扫码任务。

不采用“点击登录直接读取 App Cookie”，因为抖音 App 与知萃 WebView 的 Cookie 容器隔离，且无受支持的授权回调可完成该行为。

抖音可能先返回“验证码中间页”而不是二维码。本地可见浏览器模式识别该页面后保持同一浏览器任务，并在 UI 中要求用户亲自完成拼图；验证消失后重置二维码发现时限并继续。生产无界面模式无法安全完成交互式验证码，因此立即返回可理解的失败提示，不伪装成仍在生成二维码。用户关闭扫码面板时通过用户作用域内的取消接口终止 Playwright 任务，避免遗留窗口和重复启动。

### 6. Android 恢复前台时重新检查更新

根级更新提示在冷启动时检查公开版本清单，并在 App 从后台恢复前台时再次检查。用户已对同一 build 选择“稍后”时，本次会话内仍保持安静；新的 build 仍会显示更新日志和下载入口。Android 安全模型不允许普通应用静默替换自身 APK，因此更新流程保持为提示后由用户确认下载安装。

### 7. 首屏改为紧凑控制区

删除页面 eyebrow、主标题和说明段落。内容模式切换放入紧凑顶部工具条，连接状态和登录操作紧随其后；移动端工具条纵向回退但不重复宣传文案。来源面板与视频网格保持现有功能和可触达字号。

## Risks / Trade-offs

- [用户首次看到空资料库] → 旧全局目录不归属任何用户；明确要求重新扫码与同步，避免错误归属。
- [sidecar 内存会话随进程重启丢失二维码任务] → Cookie 和作品元数据落在各自目录；用户只需重新发起扫码任务。
- [同机深链在部分浏览器被拦截] → Android App 使用原生包启动；普通浏览器保留保存/分享二维码、手动打开抖音说明和网页回退。
- [Android 旧版本写入相册需要权限] → 仅 Android 9 及以下在用户主动保存时申请存储权限，拒绝后仍可使用另一台设备扫码。
- [抖音触发交互式验证码] → 桌面可见浏览器由用户亲自完成；无界面服务立即给出限制提示，禁止绕过验证码或无限等待。
- [会话目录长期增长] → 每个账号仅保存 JSON、封面链接和 Cookie，不保存视频；后续可按解绑/删号策略清理孤儿目录。
- [并发任务跨用户争抢进程资源] → 保留全局有界队列与限速器，但任务可见性和状态严格按 scope 过滤。

## Migration Plan

1. 先部署知萃数据库模型与后端适配器；`create_all` 创建新表。
2. 更新 sidecar 补丁并重装/重启 sidecar，创建仅 owner 可访问的 sessions 根目录。
3. 部署前端紧凑布局与移动端扫码操作。
4. 现有用户重新扫码，生成自己的绑定记录和目录；不导入旧全局 Cookie。
5. 验证两个用户的登录、同步、退出、任务和媒体读取互不影响。

回滚时可恢复旧 sidecar 和后端版本；新绑定表与 sessions 目录可保留，不影响旧版本读取原全局文件。

## Open Questions

- 抖音没有稳定公开的扫一扫深链，因此“打开抖音”只承诺启动 App，不承诺直接落到扫一扫页面。

### 8. Desktop login uses visible Chrome as the source of truth

For a desktop-capable sidecar, the installed Chrome channel is launched visibly and maximized. Zhicui polls the scoped login result, but the browser window—not the mirrored image—is the primary interaction surface. QR extraction remains an optional convenience for mobile handoff. A headed login therefore keeps waiting when QR extraction fails and tells the user to scan the code shown in Chrome. Headless production behavior remains bounded and honest because it cannot expose that interactive surface.

The production sidecar runs on a remote virtual display, so its browser is not user-visible even when Chromium itself is headed. It explicitly reports `remote_capture` rather than `visible_chrome`; the web client waits for and displays the mirrored QR image. Interactive challenges in this mode fail honestly because there is no supported remote-control surface. Only a browser running on the user's local desktop may report `browser_opened: true`.

### 9. Android uses a desktop-binding handoff

The native Android App and mobile web no longer initiate the server-side QR task. Douyin frequently requires an interactive security challenge that the production headless sidecar cannot expose, and the Douyin App does not provide a supported Cookie callback to Zhicui. An unbound mobile user therefore receives the desktop URL and same-account steps. When the App returns to the foreground it rechecks the user-scoped binding, so a desktop-completed login becomes available without rebuilding or copying credentials. The existing native QR bridge remains dormant for compatibility but is not presented as the supported binding path.

### 10. QR discovery has one automatic recovery and a manual fallback

Remote production QR discovery gets a bounded grace period. If no QR is available, the client cancels only its scoped browser, waits for the sidecar worker to finish and starts one new capture. It never loops indefinitely. A second stall keeps the panel visible and changes the spinner into an explicit fallback: local desktop users can reopen visible Chrome, while production users can regenerate the mirrored QR. The backend forwards `browser_mode` and `browser_opened` on every status response so the client never guesses which surface is actually available.

Cancellation is cooperative. The sidecar signals the worker, closes the browser process and awaits cleanup before returning; a start received during the final cleanup window is idempotent instead of becoming a connector 409 that the public API mislabels as 502.

### 11. Frontend deployments retain bounded chunk compatibility

The isolated frontend build remains atomic, but the deploy switch copies hashed static assets from the current build into the new `.next/static` tree before activation and prunes assets older than a bounded retention window. An already-open document can therefore finish loading after a deployment. A small bootstrap error handler is the final fallback: a failed `/_next/static/` script or stylesheet clears service-worker caches and reloads once, guarded by session storage to prevent loops.

### 12. Login completion follows authenticated session evidence

The sidecar no longer treats one historical pair of Cookie names as the definition of QR success. It distinguishes authenticated session Cookies (`sessionid`, `sessionid_ss`, `sid_guard`) from anonymous page Cookies and completes when at least one authenticated session marker is present. The complete sanitized Cookie set remains in the per-scope sidecar file; public status exposes only counts and booleans. The existing legacy Cookie-validity rule remains a compatibility fallback for manually supplied Cookie sets.

The backend reconciles the binding record from the authoritative sidecar Cookie status whenever login status is read, not only when the separate library-status endpoint happens to be called. Android foreground recovery uses short bounded backoff checks because the Douyin App may report confirmation a few seconds before the browser finishes writing the session.

### 13. Login browser workers are single-flight and globally bounded

Each session scope continues to own one login task. Duplicate starts return that task's current state. A process-wide FIFO-compatible `asyncio.Semaphore` limits active Playwright browser workers; tasks beyond the limit remain cancellable in an explicit `queued` browser mode. The default limit is two and is configurable independently of download-job concurrency.

The semaphore guards only the expensive browser lifetime. QR images, Cookie files, cancellation events and status remain scoped. Releasing or cancelling one slot cannot mutate another session. This permits useful multi-user concurrency without allowing a burst of login attempts to exhaust server memory.
