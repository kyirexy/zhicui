## Context

知萃已有一套桌面端与网页之间的 `desktop_handoff`：Electron 生成一个 `session_id`，打开外部浏览器，网页登录后用同一个值声明，客户端再用它轮询并领取 JWT。它适合“只有客户端和浏览器知道链接”的交接，但不能直接把该值公开为二维码，否则看到二维码的人既能确认也能抢先领取 JWT。

Windows 客户端的工作区由 `https://luxai.cn` 渲染，因此桌面二维码 UI 和轮询可以在登录页前端完成，不需要升级 Electron 主进程；旧版“打开浏览器登录”桥接继续作为兼容回退。Android 是 Capacitor 8 安装应用，生产响应的 `Permissions-Policy: camera=()` 不适合网页摄像头，因此使用原生条码插件，并重新发布 APK。

## Goals / Non-Goals

**Goals:**

- 已登录 Android 用户扫描 Windows 客户端二维码、核对设备并确认后，Windows 自动登录同一账号。
- 未登录 Android 用户扫码后可先登录或注册，随后继续同一确认流程，无需重新扫码。
- 二维码确认凭证与桌面领取凭证完全隔离，服务端只保存凭证摘要，并提供短时、一次性、可取消的状态机。
- 保持旧 Windows 客户端的浏览器联动登录可用；新 Web UI在旧桥接能力下可以回退。
- 相机只在用户主动扫码期间启用，二维码本机解析，画面不上传、不保存。

**Non-Goals:**

- 本次不替换现有 30 天 JWT、也不引入刷新令牌或完整设备会话管理。
- 本次不开放普通移动网页的摄像头扫码，不修改生产 `Permissions-Policy`。
- 本次不把抖音、B站等平台账号授权与知萃账号扫码登录合并。
- 本次不移除账号密码、注册或旧版外部浏览器登录方式。

## Decisions

### 1. 使用独立的 v2 设备登录会话表

新增 `desktop_login_sessions`，而不是在旧 `desktop_handoffs` 上增加大量可空字段。新表保存公开请求 ID、域隔离后的 `approval_token_hash` 与 `poll_secret_hash`、状态、用户、客户端标签、四位校验码、轮询时间和生命周期时间戳。旧表及旧端点保持原样，避免已安装 Windows 版本失效。

备选方案是直接扩展旧表；但项目没有 Alembic，生产表增列和索引的手工迁移风险更高，且旧协议与新协议的安全语义容易混淆。

### 2. 所有秘密由服务端生成，并使用两种独立凭证

创建接口返回：公开 `session_id`、只供桌面保存的 `poll_secret`、只放入二维码的 `approval_token`、过期时间、轮询间隔和校验码。数据库使用带用途前缀的 SHA-256 摘要，不保存明文。二维码内容采用 `https://luxai.cn/login#desktop-login=<session_id>.<approval_token>`，fragment 不会进入 HTTP 请求、代理日志或 Referer。

移动端只能用 approval token 预览和批准，不能领取 JWT；桌面端只能用 poll secret 查询和领取，不能批准。仅持有二维码内容不足以取得账号会话。

### 3. 使用显式确认而不是“扫到即授权”

扫码后移动端展示“Windows 客户端”、四位校验码、到期状态和当前账号，并要求点击“确认登录”。这是一次额外点击，但能阻断被诱导扫描、远程转发二维码和误扫其他二维码后的静默授权。用户所说的一键登录体现为：已登录手机无需再次输入账号密码，只需一次确认。

### 4. 使用乐观条件更新保证一次消费

状态机为 `pending → approved → consumed`，并允许 `pending → denied/cancelled/expired`。批准和领取都使用包含当前状态及未过期条件的原子 `UPDATE`；只有一个并发领取请求能从 `approved` 改为 `consumed`。领取前再次确认用户存在且启用。终态不允许回退。

SQLite 开发与 PostgreSQL 生产都支持该条件更新，避免依赖 PostgreSQL 行锁。客户端按服务端返回的最小间隔轮询，服务端同时记录 `last_polled_at` 并对高频请求返回等待状态。

### 5. 桌面二维码在 React 登录页直接工作

Windows 登录页调用 v2 API 创建会话，用现有 `qrcode.react` 绘制二维码，轮询成功后通过 `AuthContext.acceptSession` 写入与账号密码登录一致的会话。因为 Electron 加载正式站点，新 UI 会随 Web 部署生效，无需为这一功能修改主进程或发布新的 Windows 安装包。现有 Electron `beginZhicuiWebLogin` 仍作为“改用浏览器登录”备用。

### 6. Android 使用 ML Kit 原生条码插件

采用与 Capacitor 8 兼容的 `@capacitor-mlkit/barcode-scanning`，只启用 QR Code 格式。扫码层稳定挂载在 React 树内，不使用 body Portal，也不移动 React 管理的 DOM。开始扫码前检查和申请 CAMERA 权限；关闭、路由变化或组件卸载时始终停止扫描并移除监听。

登录页提供扫码入口；设置页也提供相同入口，使已经登录的用户可以直接使用。未登录扫码会把已验证格式的会话引用短时保存到 `sessionStorage`，登录成功后显示确认界面。

### 7. 限流、缓存与审计

创建接口按 IP 限流，所有 v2 会话操作再受统一较宽的 IP 门禁；批准按登录用户记录活动。所有响应设置 `Cache-Control: no-store`，日志只记录会话 ID、状态和用户 ID，不记录 approval token、poll secret、二维码 URL 或 JWT。创建新会话时清理过期超过一天的终态记录。

## Risks / Trade-offs

- [Android 原生插件增加 APK 体积] → 只启用条码模块和 QR 格式，并在构建后检查 APK 大小与启动性能。
- [国内设备缺少 Google Play Services] → 使用插件的自定义 `startScan` 摄像头路径，而不是依赖 Google Barcode Scanner UI。
- [用户拒绝相机权限] → 保留账号密码登录，提示可在系统设置中开启权限，不循环弹窗。
- [桌面轮询在服务切换时中断] → 会话持续五分钟，UI提供刷新二维码；部署先发布兼容后端，再切换 Web。
- [JWT 领取后网络断开导致客户端未收到] → 会话仍按一次消费处理以优先避免重复签发；UI提示重新扫码。后续设备会话系统可用可撤销交换码解决这一极小窗口。
- [脏工作区包含其他未发布变更] → 提交时只暂存本变更的文件或精确 hunks，部署前核对提交差异，避免把无关本地改动带入生产。

## Migration Plan

1. 先发布新增模型、v2 API、限流和测试；`Base.metadata.create_all()` 创建新表，旧接口保持兼容。
2. 发布 Web 登录页和认证上下文；桌面客户端从正式站点立即获得二维码 UI，旧客户端仍可使用浏览器回退。
3. 构建 Android beta APK，验证权限拒绝/允许、扫码、登录后继续确认、取消和重复消费。
4. 完成正式 API 冒烟和两端端到端验收后，按现有签名与版本递增门禁发布 Android stable。
5. 若 Web 出现问题，原子部署回滚到上一版；新表和 v2 API可保留且不影响旧协议。若 Android 出现问题，撤下新渠道清单并继续提供账号密码与旧 APK。

## Open Questions

- 无。首版固定五分钟有效期、两秒轮询间隔和“Windows 客户端”设备标签，后续再根据真实使用数据调整。
