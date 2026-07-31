## Context

知萃当前由 Next.js 客户端和线上 FastAPI API 组成，Android 使用 Capacitor 静态构建。抖音收藏同步依赖一个按知萃账号 `session_scope` 隔离的扫码服务；已有后端接口可以签发十分钟有效的一次性交接 token，并在回调时把 Cookie 直接写入扫码服务会话，数据库只保留绑定元数据。

网页不能读取另一个站点的 Cookie。把浏览器放在服务器会暴露 Linux/服务器地区并触发异地风控；要求用户单独运行 localhost 连接器又不符合消费产品体验。因此新增 Windows 桌面应用，把本机浏览器能力作为完整产品的一部分。

## Goals / Non-Goals

**Goals:**

- 交付一个可安装的 Windows 知萃应用，完整呈现现有视频库、问答、计划和知识卡。
- 从桌面应用在本机启动真实 Chrome，缺失时回退 Edge，完成抖音扫码并自动回到知萃。
- 不显示 localhost、端口、服务器 Linux 或服务器地理位置。
- 复用现有用户账号、正式 API 和短时签名 Cookie 交接，不新增敏感数据库字段。
- 提供单实例、`zhicui://` 深链、可信导航限制和自动更新基础。
- 网页能够明确引导打开/下载桌面端，移动端说明一次绑定后的跨端关系。

**Non-Goals:**

- 第一版不做 macOS/Linux 安装包。
- 第一版不把 Python 下载器、ASR 或视频文件打包到桌面端；内容处理仍由现有服务完成。
- 不读取用户日常 Chrome 个人资料；扫码使用临时隔离的本机 Chrome 上下文。
- 不绕过抖音安全验证，不承诺消除抖音自身的所有风控。
- 不在没有代码签名证书的情况下伪装成已签名发布。

## Decisions

1. **使用 Electron + 远程 Web 产品壳。** 桌面窗口加载 `https://luxai.cn`，因此业务 UI 更新无需重新发布整包；Electron 只承载本机能力。相比重写原生界面或打包完整后端，这是最快且与现有 React 代码重复最少的方式。

2. **使用 `playwright-core` 启动系统 Chrome/Edge。** 不下载额外 Chromium，也不读取用户日常浏览器配置。登录使用临时 profile、真实 Windows 网络出口，完成或取消后关闭上下文并清理目录。相比 Electron 内嵌 WebView，这更接近用户熟悉的 Chrome 且减少 Electron UA 风控。

3. **只暴露最小 preload API。** Renderer 无 Node 权限；`contextIsolation`、sandbox、导航白名单与 IPC sender origin 校验全部启用。桥只提供运行时信息、抖音登录/取消和更新检查。

4. **复用一次性交接协议。** 已登录的知萃页面先向后端申请 token，再通过 IPC 交给主进程。主进程只允许回调到精确的知萃生产路径或显式本地开发 origin；完成后 POST `{token,cookies}`。后端再次核对 token、用户、绑定与 scope。

5. **Cookie 有界且不落桌面应用业务存储。** 主进程只收集 `.douyin.com` Cookie，限制数量、名称、值和总载荷；仅检测认证证据后回传。临时浏览器 profile 清理后，Cookie 只存在扫码服务的隔离会话中。

6. **网页不再自动访问 localhost。** 桌面运行时由 preload 明确识别并使用 IPC；普通桌面网页尝试 `zhicui://` 唤起已安装应用，并始终提供安装包入口；移动端给出电脑绑定说明。

7. **使用 electron-builder NSIS 与 GitHub Release 更新。** 第一版生成 x64 安装包并声明 `zhicui` 协议。`electron-updater` 在打包环境检查 GitHub Release；代码签名证书作为正式公开发布前的运维前置项。

## Risks / Trade-offs

- **[Windows SmartScreen 警告]** → 首个内部测试包可无签名；公开推广前购买 EV/OV 代码签名证书并配置 CI secrets。
- **[用户没有 Chrome]** → 自动回退 Microsoft Edge；两者都不可用时给出清晰安装提示。
- **[抖音改变登录 Cookie 或页面行为]** → 认证证据名称集中维护，后端仍做最终有效性校验。
- **[远程页面被导航到恶意站点]** → 主窗口阻止非知萃 origin 导航，外部链接交给系统浏览器，IPC 校验 sender origin。
- **[更新包较大]** → 业务 UI 远程加载减少发布频率；启用 NSIS 差分更新元数据。
- **[深链唤起无法被网页可靠检测]** → 网页同时展示“已安装则打开”和“未安装则下载”，不把协议失败当作登录成功。

## Migration Plan

1. 新增桌面工程并本机构建未签名测试安装包。
2. 部署前端桌面运行时检测与下载/唤起入口；旧本地交接 API 保持兼容。
3. 用测试知萃账号验证 Chrome、Edge 回退、成功、取消、超时与换绑。
4. 配置 GitHub Release 和代码签名后发布首个正式安装包。
5. 回滚只需停止分发安装包并恢复网页入口，不涉及数据库迁移。

## Open Questions

- 正式公开发布前需要确定 Windows 代码签名证书主体与 GitHub Release 发布权限。
