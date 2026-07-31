## MODIFIED Requirements

### Requirement: Site favicon is available
前端 SHALL 在 `/favicon.ico` 提供有效的品牌图标资源，Windows 桌面应用 MUST 使用同一品牌符号的多尺寸应用图标。

#### Scenario: Browser requests the favicon
- **WHEN** 浏览器请求 `/favicon.ico`
- **THEN** 服务器返回成功响应和可解析的 ICO 图标，不产生 404

#### Scenario: Windows desktop package is built
- **WHEN** Electron Builder 生成 Windows 可执行文件和安装包
- **THEN** 应用窗口、任务栏、桌面快捷方式和安装包使用知萃品牌图标，而不是 Electron 默认图标
