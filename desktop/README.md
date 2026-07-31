# 知萃 Windows 桌面端

桌面端加载正式知萃产品，只提供网页无法安全实现的本机能力：

- 本机 Chrome/Edge 抖音扫码登录
- `zhicui://` 深链
- 单实例窗口
- GitHub Release 自动更新基础

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

## Windows 安装包

```powershell
npm run dist:win
```

产物位于 `desktop/release-<version>/`。首个内部测试包可以不签名；公开发布前必须配置 Windows 代码签名证书，否则 SmartScreen 会显示未知发布者。
