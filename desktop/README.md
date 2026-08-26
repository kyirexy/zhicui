# 知萃 Windows 桌面端

桌面端加载正式知萃产品，只提供网页无法安全实现的本机能力：

- 本机 Chrome/Edge 抖音扫码登录
- 本机 Chrome/Edge B站、小红书账号登录与最近喜欢/收藏同步
- 可选的视频本地保存、自定义目录和本地优先播放
- `zhicui://` 深链
- 单实例窗口
- luxai.cn 受控更新源、后台下载和左下角一键完成更新

## 开发

推荐在仓库根目录直接双击 `start-desktop.bat`，或在 PowerShell 中运行：

```powershell
cd D:\6month
.\start-desktop.bat
```

启动器会复用已经运行的本地服务；缺失时自动启动后端 `:8000` 和网页端
`:3003`，确认服务就绪后再打开 Electron。桌面窗口关闭后，只会停止由本次
启动器创建的服务。

首次安装或需要更新全部依赖时：

```powershell
.\start-desktop.bat -Install
```

如果希望桌面窗口关闭后仍保留后端和网页端：

```powershell
.\start-desktop.bat -KeepServices
```

也可以手动启动：

```powershell
cd desktop
npm install
$env:ZHICUI_DESKTOP_URL='http://localhost:3003'
npm run dev
```

不设置 `ZHICUI_DESKTOP_URL` 时加载 `https://luxai.cn`。

## 本地视频

桌面端默认仍采用远程按需播放，不会自动占用磁盘空间。用户可以在
「设置 → 本地视频」中：

- 开启“播放时自动保存”，第一次播放时后台保存，之后优先本地播放；
- 选择任意可写目录，默认目录为 Windows「视频\知萃」；
- 在单条视频详情中手动保存、查看进度、打开文件位置或删除本地副本。

设置和缓存索引保存在 Electron 用户数据目录；视频与封面只写入用户选择的
本机目录。切换保存目录不会移动已有文件。删除本地副本不会删除云端文稿、
知识卡、计划或资料库记录，服务器和数据库也不会保存这些视频文件。

## B站与小红书账号同步

在「视频资料 → 账号同步」中可以连接 B站或小红书，并同步最近 10 条喜欢或
收藏。平台登录只发生在本机 Chrome/Edge 的独立浏览器 profile 中，Cookie、
LocalStorage 和登录令牌不会发送给知萃网页、后端或数据库。不同知萃用户、
不同平台使用相互隔离的本机会话目录。

- B站：登录后通过当前账号接口读取最近点赞视频和收藏夹作品。
- 小红书（Beta）：登录后会打开官方页面；同步时请进入自己的个人主页，知萃
  只读取「点赞/收藏」标签中页面已经展示或有限滚动后出现的链接。
- Android 与普通网页继续支持链接导入，但不能读取系统浏览器或其他 App 的
  登录会话。

小红书没有稳定公开的收藏 API，页面结构变化或平台风控可能导致同步失败。
客户端不会绕过验证码、访问私密内容或进行无限滚动；遇到异常时请降低频率，
或继续使用分享链接导入。

## Windows 安装包

```powershell
npm run dist:win
```

产物位于 `desktop/release-<version>/`。首个内部测试包可以不签名；公开发布前必须配置 Windows 代码签名证书，否则 SmartScreen 会显示未知发布者。

## 发布桌面更新

Electron 使用 `https://luxai.cn/download/windows/` generic feed。每个版本必须同时包含：

- `latest.yml`
- 版本化 NSIS 安装包 `Zhicui-Setup-<version>-x64.exe`
- 对应 `.blockmap` 差分文件

在仓库根目录执行：

```powershell
.\scripts\release-desktop.ps1 -Version 1.0.4 -Publish
```

脚本会更新版本号、构建并核验 SHA-512，先上传 EXE 和 blockmap，最后原子切换
`latest.yml`。没有代码签名时脚本默认拒绝公开发布；仅限内部验证时可显式追加
`-AllowUnsigned`。客户端启动 12 秒后、窗口重新聚焦时和每小时都会检查更新，
下载期间继续可用，完成后左下角出现“完成更新”。
