## Context

移动网页与 Capacitor Android 共用 Next.js 客户端，Windows Electron 则加载同一线上 UI 并通过受限 preload bridge 暴露本机能力。Android 已有公开版本清单与启动检查；Windows 已使用 `electron-updater`，但当前只返回一次检查结果，下载状态和安装动作未进入 UI。

## Goals / Non-Goals

**Goals**

- 让 360–430px 宽度下的核心页面具有清晰层级、足够触控面积，并避开底部安全区。
- 让 Android 与 Windows 都能自动发现新版、看到更新状态并完成更新。
- 让普通网页用户在设置页清楚找到 Android 和 Windows 客户端。

**Non-Goals**

- 不重写现有页面或引入新的 UI 组件库。
- 不实现 iOS 原生包或应用商店内更新。
- 不在服务器或业务数据库保存安装包、视频文件或抖音 Cookie。

## Decisions

1. **底部空间使用单一 CSS 变量。** 移动端以底部导航高度、安全区和呼吸空间计算主内容尾部留白；反馈按钮固定在导航上方，避免各页面分别硬编码。
2. **视频库继续使用双列网格。** 双列更适合 50–100 条收藏的浏览效率，通过略增字号、44px 选择/播放热区和简化次要信息改善可用性；极窄屏才退化为单列。
3. **更新 UI 按运行时分支。** Android 继续使用公开清单和系统浏览器下载；Windows 通过 preload bridge 获取版本、订阅状态并触发 `quitAndInstall`；普通 Web 只展示下载入口，不伪造安装状态。
4. **Electron 主进程拥有更新状态。** `electron-updater` 事件在主进程归一化后发送到可信 renderer；preload 只暴露读取、检查、订阅和安装四个有限接口。
5. **自动检查不打断当前任务。** 启动后延迟检查并自动下载；仅在新版已下载后显示可操作提示。失败仅在设置页呈现，不阻断扫码、同步或问答。
6. **动效保持短促且可降级。** 新增状态变化只使用透明度/位移，持续时间不超过 180ms，并尊重 `prefers-reduced-motion`。

## Risks / Trade-offs

- **GitHub Release 尚未包含新版安装包**：客户端会安全返回检查失败；正式发布安装包与 `latest.yml` 后自动恢复。
- **Windows 安装包未签名**：系统可能显示未知发布者；更新 UI 会明确版本来源，正式公测前仍建议配置代码签名。
- **移动端双列仍可能拥挤**：在 359px 以下切换单列，常见 360–430px 设备保持双列。

## Verification

1. 在 360×800、390×844、430×932 视口检查首页、视频库、计划、设置和登录页。
2. 检查底部导航、反馈按钮、弹窗和最后一条内容不互相遮挡。
3. 在开发桌面运行时模拟更新状态，验证提示、进度与安装动作契约。
4. 运行 Next.js 生产构建、Capacitor production build、Electron typecheck 和 Windows NSIS 构建。
