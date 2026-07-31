## Why

桌面端当前固定使用深色侧栏，品牌入口和 Windows 图标也缺少一致的视觉层级，用户无法根据环境亮度和阅读习惯调整工作区。需要把桌面外观从硬编码样式变成明确、可持久化的产品设置，同时保证同一套前端代码在本地 Electron 和云端加载时行为一致。

## What Changes

- 在设置页新增“外观与布局”，允许选择浅色、深色或跟随系统的桌面侧栏。
- 提供舒展与紧凑两种桌面内容密度，并即时应用到侧栏、顶部栏和工作区间距。
- 重新设计桌面左上角品牌入口，使用更清晰的图标容器、产品名和版本语义。
- 统一网页 favicon、桌面安装包图标和桌面窗口图标的品牌资源。
- 使用本地持久化保存外观偏好；设置与前端代码一起部署，生产环境无需额外数据库迁移。

## Capabilities

### New Capabilities

- `desktop-appearance-preferences`: 桌面外观模式、布局密度、持久化和运行时应用规则。

### Modified Capabilities

- `production-deploy-safety`: 扩展品牌图标要求，覆盖网页 favicon 与 Windows 桌面应用图标。

## Impact

- 前端：`SettingsContext`、设置页、桌面壳层、桌面运行时 CSS 和主题初始化。
- 静态资源：浏览器图标与 Windows 安装包图标。
- 桌面构建：Electron Builder 图标路径和窗口图标。
- 部署：仍使用现有 Next.js/Jenkins 流程，无后端接口和数据库变化。
