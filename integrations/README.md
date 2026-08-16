# 第三方集成

## OmniRoute

- 上游仓库：<https://github.com/diegosouzapw/OmniRoute>
- 当前固定提交：`84b1e5e12f238269e698f400766230f985f4a07b`
- 许可证：MIT，版权归 `diegosouzapw` 所有
- 本地目录：`integrations/OmniRoute`

OmniRoute 作为独立的 OpenAI 兼容网关运行，知萃只通过 HTTP API 与其通信，不修改或打包它的前端依赖。首次检出包含子模块的仓库时运行：

```bash
git submodule update --init --recursive
```

升级时先在独立分支验证上游版本，再更新子模块指针和上面的固定提交。上游的完整 MIT 许可证保留在 `integrations/OmniRoute/LICENSE`。

## XHS-Downloader

- 上游仓库：<https://github.com/JoeanAmier/XHS-Downloader>
- 当前固定提交：`4f0f7a406551ef1e97f2bea1207b3be1703173b3`
- 上游版本：`2.8`
- 许可证：GPL-3.0，版权归 `JoeanAmier` 及项目贡献者所有
- 本地目录：`integrations/XHS-Downloader`

XHS-Downloader 作为独立 sidecar 运行，知萃只通过它的 `/xhs/detail`
HTTP API 读取作品元数据和临时媒体地址，不复制或修改上游源码。知萃请求
始终使用 `download: false`，不会让 sidecar 持久下载作品文件。

上游 README 中的账号收藏/点赞提取由浏览器用户脚本完成，`/xhs/detail` HTTP
API 并不提供账号登录或收藏列表接口。知萃桌面端因此采用本机官方页面的可见
链接采集，登录态不会发送给此 sidecar 或知萃后端。

首次检出后初始化并启动：

```bash
git submodule update --init --recursive integrations/XHS-Downloader
cd integrations/XHS-Downloader
python3.12 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python main.py api
```

Windows PowerShell 使用 `.venv\\Scripts\\python.exe main.py api`。默认服务地址
是 `http://127.0.0.1:5556`；知萃通过以下环境变量连接：

```dotenv
XHS_DOWNLOADER_API_BASE=http://127.0.0.1:5556
XHS_DOWNLOADER_TIMEOUT_SECONDS=20
XHS_COOKIE=
```

`XHS_COOKIE` 只在后端与 sidecar 之间传递，不得写入前端配置、日志或错误响应。
未启动 sidecar 时，知萃会回退到内置小红书正文抓取器，但可能只能得到发布
文案，无法取得视频地址和视频语音。
