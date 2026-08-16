## ADDED Requirements

### Requirement: Installed clients require authentication before workspace entry
Windows Electron 与 Android Capacitor 客户端 MUST 在认证状态恢复完成后才允许进入工作台；无有效用户会话时 MUST 导向统一登录/注册页，并 MUST NOT 展示工作台导航、用户名称、业务数据骨架或启动受保护数据请求。

#### Scenario: First client launch without a session
- **WHEN** 用户首次启动 Windows 或 Android 客户端且本地没有有效 token
- **THEN** 客户端展示登录/注册页且不展示工作台壳层

#### Scenario: Saved session is valid
- **WHEN** 客户端启动并成功恢复有效用户会话
- **THEN** 客户端进入原目标工作台并展示已登录导航

#### Scenario: Saved session has expired
- **WHEN** 客户端保存了 token 但服务端拒绝该会话
- **THEN** 客户端清除失效 token 并展示登录/注册页

### Requirement: Browser marketing home remains public
普通浏览器访问根路由时 SHALL 继续看到公开官网，且客户端认证门禁 MUST NOT 将官网访客强制重定向到登录页。

#### Scenario: Anonymous browser visits home
- **WHEN** 未登录用户使用普通浏览器访问 `/`
- **THEN** 系统展示公开产品首页

### Requirement: Authentication returns users to the requested client destination
客户端登录或注册成功后 SHALL 返回安全的站内目标路由；退出登录后 SHALL 立即移除工作台壳层并返回登录页。

#### Scenario: User signs in from a protected route
- **WHEN** 未登录客户端从受保护目标进入登录页并成功登录
- **THEN** 客户端返回该站内目标路由

#### Scenario: User signs out
- **WHEN** 已登录客户端用户执行退出登录
- **THEN** 客户端清除会话、隐藏工作台壳层并显示登录页

### Requirement: Development session bypass is explicit
本地开发环境 MUST 默认使用真实登录/注册流程；自动创建开发会话仅 SHALL 在显式配置开发免登录开关时启用。

#### Scenario: Developer starts the app without bypass configuration
- **WHEN** 本地开发构建启动且未启用开发免登录开关
- **THEN** 未登录用户看到真实登录/注册页

#### Scenario: Developer explicitly enables bypass
- **WHEN** 本地开发构建显式启用开发免登录开关
- **THEN** 客户端可以请求后端签发的开发会话
