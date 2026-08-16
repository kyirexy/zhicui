## MODIFIED Requirements

### Requirement: Release metadata drives native versioning

Android 构建 SHALL 使用版本清单中的版本名与整数构建号生成原生 `versionName` 和 `versionCode`，发布或本地交付构建 SHALL 在生成 APK 前校验清单，并 SHALL 在生成后刷新 APK 文件大小与发布时间。自动提交和远程推送 SHALL 只在明确执行发布流程时发生。

#### Scenario: 本地生成可安装包

- **WHEN** 开发者为本地验收构建 Android APK
- **THEN** APK 原生版本与版本清单一致
- **AND** APK 使用生产 API 并被复制到公开下载目录
- **AND** 版本清单的文件大小和发布时间与新产物一致
- **AND** 构建过程不自动提交或推送 Git

#### Scenario: Release metadata is incomplete

- **WHEN** 版本清单缺少版本号、构建号、下载地址或更新日志
- **THEN** 构建在 Gradle 打包或任何 Git 操作前失败
