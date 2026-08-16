## ADDED Requirements

### Requirement: Web visitors can discover both client platforms
Web 营销首页 SHALL 在无需登录的情况下同时展示 Android 与 Windows 客户端入口，并 SHALL NOT 因访问设备或视口宽度隐藏其中一个平台。

#### Scenario: Desktop visitor opens the marketing page
- **WHEN** 访客使用桌面浏览器打开 Web 营销首页
- **THEN** 页面展示 Windows 与 Android 两个可操作的下载入口

#### Scenario: Mobile visitor opens the marketing page
- **WHEN** 访客使用手机浏览器打开 Web 营销首页
- **THEN** 页面仍展示 Android 与 Windows 两个可操作的下载入口

### Requirement: Download information follows public release manifests
Web 下载中心 SHALL 从 Android 与 Windows 的公开发布清单读取版本、下载地址与文件元数据，并 SHALL 将两个清单作为彼此独立的数据源处理。

#### Scenario: Both manifests are valid
- **WHEN** Android 与 Windows 公开发布清单均返回有效数据
- **THEN** 页面分别显示两个平台的真实版本、安装包大小与下载地址

#### Scenario: One manifest is unavailable
- **WHEN** 其中一个平台的发布清单请求失败或内容无效
- **THEN** 页面为该平台使用安全回退信息且另一平台继续使用其真实清单数据

#### Scenario: Manifest contains an untrusted URL
- **WHEN** 发布清单提供的下载地址既不是同源相对地址也不是 HTTPS 地址
- **THEN** 页面拒绝该地址并使用已知可信的官方回退地址

### Requirement: Platform recommendation is informative and non-blocking
Web 下载中心 SHALL 在能够识别访问设备时标记本机推荐平台，并 MUST 保持另一平台入口可见且可下载。

#### Scenario: Windows visitor views downloads
- **WHEN** 浏览器被识别为 Windows 设备
- **THEN** Windows 客户端显示“本机推荐”且 Android 客户端仍可下载

#### Scenario: Android visitor views downloads
- **WHEN** 浏览器被识别为 Android 设备
- **THEN** Android 客户端显示“本机推荐”且 Windows 客户端仍可下载

#### Scenario: Platform cannot be identified
- **WHEN** 浏览器平台无法可靠识别
- **THEN** 页面不作强制推荐并继续显示两个平台入口

### Requirement: Header leads to a platform-neutral download choice
Web 顶部导航 SHALL 提供一个平台中性的“下载客户端”入口并定位到同页下载中心，而不是按视口只直链某一个客户端。

#### Scenario: Visitor activates the header download link
- **WHEN** 访客点击顶部的“下载客户端”入口
- **THEN** 页面定位到同时包含 Android 与 Windows 的下载中心

### Requirement: Download center uses the neutral product visual language
Web 下载中心 SHALL 使用白色背景、中性灰黑文字和语义明确的平台图标；除品牌 Logo 外，下载卡片、状态与按钮 MUST NOT 依赖绿色或紫色表达主要层级。

#### Scenario: Visitor scans the download center
- **WHEN** 下载中心完成渲染
- **THEN** 访客可通过平台名称、图标、版本和主操作一眼区分 Windows 与 Android，且无需阅读大段说明文字

### Requirement: Public client downloads remain directly accessible
Android APK 与 Windows 安装包 SHALL 通过公开 HTTPS 地址直接访问且 SHALL NOT 要求用户登录。

#### Scenario: Unauthenticated visitor downloads Android
- **WHEN** 未登录访客点击 Android 下载入口
- **THEN** 浏览器开始访问公开 APK 地址且不跳转登录页

#### Scenario: Unauthenticated visitor downloads Windows
- **WHEN** 未登录访客点击 Windows 下载入口
- **THEN** 浏览器开始访问公开 Windows 安装包地址且不跳转登录页
