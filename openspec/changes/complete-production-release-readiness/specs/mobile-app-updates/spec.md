## ADDED Requirements

### Requirement: Android stable 清单只发布 Release APK
Android stable 发布 MUST 验证 APK 不可调试、使用固定允许的 release 证书指纹、版本号与清单一致且通过签名校验；Debug APK SHALL 仅进入明确标记的 beta 渠道。

#### Scenario: Release APK 验证通过
- **WHEN** APK 的 debuggable 标志关闭、签名指纹匹配且版本元数据一致
- **THEN** 发布脚本允许原子更新 stable 清单

#### Scenario: Debug APK 被误选
- **WHEN** 发布脚本检测到 debug 证书或可调试应用
- **THEN** stable 发布失败且当前公开正式版本不变

### Requirement: Android 更新展示发行渠道与安装边界
Android 设置和更新提示 SHALL 显示 stable 或 beta 渠道，并 SHALL 明确更新通过系统浏览器下载、由系统安装器确认，不得描述为静默热更新。

#### Scenario: 用户点击更新
- **WHEN** 用户从 Android 客户端打开新版下载
- **THEN** 界面在离开前说明下载和安装确认步骤，并保持当前数据不受影响
