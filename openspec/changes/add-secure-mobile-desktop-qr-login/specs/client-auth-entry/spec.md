## MODIFIED Requirements

### Requirement: Installed clients require authentication before workspace entry
Windows Electron 与 Android Capacitor 客户端 MUST 在认证状态恢复完成后才允许进入工作台；无有效用户会话时 MUST 导向统一登录/注册页，并 MUST NOT 展示工作台导航、用户名称、业务数据骨架或启动受保护数据请求。Windows 登录页 SHALL 展示安全的扫码登录二维码，Android 登录页 SHALL 展示“扫码登录电脑”入口；两端 MUST 保留账号密码登录作为回退。

#### Scenario: First Windows client launch without a session
- **WHEN** 用户首次启动 Windows 客户端且本地没有有效 token
- **THEN** 客户端展示包含桌面登录二维码与账号密码回退的登录页，且不展示工作台壳层

#### Scenario: First Android client launch without a session
- **WHEN** 用户首次启动 Android 客户端且本地没有有效 token
- **THEN** 客户端展示包含“扫码登录电脑”、登录与注册入口的页面，且不展示工作台壳层

#### Scenario: Saved session is valid
- **WHEN** 客户端启动并成功恢复有效用户会话
- **THEN** 客户端进入原目标工作台并展示已登录导航

#### Scenario: Saved session has expired
- **WHEN** 客户端保存了 token 但服务端拒绝该会话
- **THEN** 客户端清除失效 token 并展示登录/注册页

### Requirement: Authentication returns users to the requested client destination
客户端登录、注册或完成桌面扫码换票后 SHALL 返回安全的站内目标路由；退出登录后 SHALL 立即移除工作台壳层并返回登录页。Android 在登录前扫描了有效桌面码时，登录或注册成功后 SHALL 优先继续该设备确认流程。

#### Scenario: User signs in from a protected route
- **WHEN** 未登录客户端从受保护目标进入登录页并成功登录
- **THEN** 客户端返回该站内目标路由

#### Scenario: Android user signs in with a pending desktop approval
- **WHEN** 未登录 Android 用户扫码后完成登录或注册
- **THEN** 客户端显示待登录 Windows 设备与确认操作，不先跳离到普通工作台

#### Scenario: Desktop completes QR token exchange
- **WHEN** Windows 登录页成功领取经手机批准的账号会话
- **THEN** 客户端保存会话并进入原目标工作台

#### Scenario: User signs out
- **WHEN** 已登录客户端用户执行退出登录
- **THEN** 客户端清除会话、隐藏工作台壳层并显示登录页

## ADDED Requirements

### Requirement: Signed-in Android users retain a direct scanner entry
已登录 Android 客户端 SHALL 在设置的账号区域提供“扫码登录电脑”入口，使用户无需退出当前账号即可授权 Windows 客户端。

#### Scenario: Signed-in user opens scanner from settings
- **WHEN** 已登录 Android 用户在设置中点击“扫码登录电脑”
- **THEN** 客户端启动与登录页相同的安全扫码和确认流程
