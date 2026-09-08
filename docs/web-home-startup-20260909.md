# 官网首屏启动提示修复（2026-09-09）

## 问题与范围

- 普通浏览器打开官网也会先看到“正在启动客户端…”。
- 原因是共享 AuthGuard 在桌面运行时确认前无条件输出客户端启动卡片，首页本身又等待运行时和移动端检查才输出官网。
- 本轮只修复官网首屏，不改变账号验证、客户端专属路由、发行包或后端接口。

## 修改

- 仅 `/` 在运行时未就绪时允许渲染首页；该阶段 HomePage 固定输出公开 WebLandingPage，不挂载私人工作台。
- 首屏 HTML 直接包含官网标题与下载链接；普通浏览器检测完成后保留同一棵官网组件树。
- 复用 head 中原生/桌面启动标记，隐藏客户端里临时的公开首屏，避免闪现官网。
- 其他路径仍保持门禁；修复重定向 effect 遗漏 desktopResolved 的依赖。

## 验证

- 新增 `homeBootstrap.test.ts`：13 项真实组件初始渲染与 Effect 驱动回归。
- 与 clientAuthPolicy、marketingHomepage、publicReleaseContract、loginExperience、iosMobile 合跑：42 项通过。
- TypeScript 检查通过，git diff --check 通过，UI 检测器未返回发现。
- 默认 Turbopack 在本机 worktree 的外部 node_modules junction 上报越根错误；未修改工程配置，使用 `next build --webpack` 完成生产构建。Jenkins 使用独立 npm ci 依赖，不依赖该 junction。
- 本地生产服务原始 HTML（移除 script 后）：官网标题、Android 下载链接存在；“正在启动客户端”不存在。
- 本地 Chrome 手机首屏目视确认，官网与固定底栏下载入口正常。
- 独立浏览器 10/10 组通过：禁 JS、阻断 42 个脚本、320/390/1440px 首次加载与刷新、过期 token、匿名 admin 与 library 门禁，以及 Android/延迟桌面桥接模拟。正常用例无 pageerror；原生与桌面模拟采样未出现可见营销首屏。测试 API 全部 mock，不代表真实账号登录测试。
- 证据保存在 `.tmp/home-bootstrap-20260909/`：原始 HTML、截图、MutationObserver/RAF 启动采样与 `results.json`。

## 发布

- 使用既有 GitHub/Gitee → Jenkins 原子发布流程，发布结果以 Jenkins 日志及公网 build-version.json 为准。
- 官网更新不要求用户重装 Android 安装包。
