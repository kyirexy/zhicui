## MODIFIED Requirements

### Requirement: Production health checks cover frontend and backend
部署完成的判定 MUST 同时要求后端健康接口、真实前端设置页与桌面扫码登录会话创建/无凭证领取拒绝检查成功；检查过程 MUST NOT 批准真实用户或生成可被日志记录的长期 JWT。

#### Scenario: Only a subset of services is healthy
- **WHEN** `/api/health`、`/settings` 或扫码登录安全冒烟任一检查失败
- **THEN** 部署不得报告成功

#### Scenario: Core services and QR login contract are healthy
- **WHEN** 后端健康、前端页面、扫码会话创建以及错误领取凭证拒绝均成功
- **THEN** 部署可以报告成功并清理回滚备份

## ADDED Requirements

### Requirement: Android scanner releases pass native capability gates
包含扫码登录的 Android 正式版本 MUST 使用既有发行签名、严格递增版本和非调试构建，并 MUST 在发布前验证 CAMERA 权限、扫码取消、有效码确认、无效码拒绝和相机关闭。

#### Scenario: Scanner build has not passed device acceptance
- **WHEN** Android 产物缺少相机权限、签名/版本门禁或跨端扫码验收证据
- **THEN** 发行流程拒绝把该产物发布为 stable

#### Scenario: Scanner build passes device acceptance
- **WHEN** 同一字节 APK 已在 Android 设备完成权限与跨端登录验收且其他发行门禁通过
- **THEN** 发行流程可以发布该 APK 与对应渠道清单
