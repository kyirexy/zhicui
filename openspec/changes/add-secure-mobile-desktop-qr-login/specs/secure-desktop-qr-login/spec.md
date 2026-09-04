## ADDED Requirements

### Requirement: Desktop login QR uses separated one-time credentials
系统 MUST 为每次桌面扫码登录创建短时设备登录会话，并 MUST 为移动端批准和桌面端领取生成彼此独立的高熵凭证；二维码 MUST NOT 包含桌面领取凭证，服务端 MUST NOT 保存任一凭证明文。

#### Scenario: Desktop creates a login QR session
- **WHEN** Windows 登录页请求新的扫码登录会话
- **THEN** 服务端返回公开会话 ID、只供桌面保存的领取凭证、二维码批准地址、校验码、过期时间和最小轮询间隔

#### Scenario: QR content is disclosed
- **WHEN** 第三方只能看到或复制二维码内容
- **THEN** 第三方不能凭二维码中的会话 ID 和批准凭证调用桌面领取接口取得 JWT

### Requirement: Mobile user explicitly approves the desktop login
Android 客户端 SHALL 在本机解析知萃登录二维码，展示目标设备、校验码和当前账号，并 MUST 仅在用户明确确认后将该账号绑定到待登录桌面会话。

#### Scenario: Signed-in user scans a valid code
- **WHEN** 已登录 Android 用户主动扫描有效且未过期的知萃桌面登录二维码
- **THEN** 客户端展示 Windows 设备与校验码，并提供“确认登录”和“取消”操作

#### Scenario: Signed-out user scans a valid code
- **WHEN** 未登录 Android 用户扫描有效二维码
- **THEN** 客户端保留待确认会话，要求用户先登录或注册，并在成功后继续显示确认操作而不要求重新扫码

#### Scenario: User scans an unrelated QR code
- **WHEN** 扫描结果不是受信任的知萃登录地址或凭证格式不合法
- **THEN** 客户端拒绝该二维码且不向批准接口发送请求

### Requirement: Login session state is bounded and single-consumption
服务端 MUST 以 `pending`、`approved`、`consumed`、`denied`、`cancelled` 和 `expired` 管理设备登录会话，MUST 原子地限制每个会话最多成功领取一次，并 MUST 在领取前再次确认批准账号仍存在且启用。

#### Scenario: Approved desktop polls with the correct secret
- **WHEN** 会话已获批准、尚未过期且桌面提交正确领取凭证
- **THEN** 服务端原子地把会话标记为 consumed，并仅向该请求返回一次普通用户 JWT 与用户资料

#### Scenario: Two pollers race to consume one session
- **WHEN** 两个请求同时使用相同正确领取凭证领取已批准会话
- **THEN** 最多一个请求成功取得 JWT，另一个请求收到已消费状态

#### Scenario: Secret, state, or expiry is invalid
- **WHEN** 请求使用错误凭证、终态会话、过期会话或已禁用用户
- **THEN** 服务端不签发 JWT，并返回不泄露凭证细节的安全状态

### Requirement: QR login endpoints are private and abuse bounded
所有扫码登录接口 MUST 返回 `Cache-Control: no-store`，MUST 受到创建、轮询和用户批准限流，并 MUST NOT 在活动日志或错误日志中记录批准凭证、领取凭证、二维码完整内容或 JWT。

#### Scenario: Client polls faster than the allowed interval
- **WHEN** 桌面端以高于服务端允许间隔的频率轮询同一会话
- **THEN** 服务端不执行换票并返回继续等待或限流结果

#### Scenario: Login activity is recorded
- **WHEN** 用户批准、拒绝或成功完成扫码登录
- **THEN** 系统记录不含任何秘密值的账号活动与结果状态

### Requirement: Camera use is user initiated and local
Android 客户端 MUST 仅在用户主动点击扫码入口后请求 CAMERA 权限并启动相机，二维码画面 MUST 只在设备本地解析且 MUST NOT 上传或保存。

#### Scenario: User closes the scanner
- **WHEN** 用户取消扫码、切换路由或扫码组件卸载
- **THEN** 客户端停止相机、移除扫描监听并恢复正常页面背景

#### Scenario: User denies camera permission
- **WHEN** 用户拒绝 CAMERA 权限
- **THEN** 客户端说明如何在系统设置开启权限，并继续提供账号密码登录方式
