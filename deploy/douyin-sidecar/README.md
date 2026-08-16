# 知萃抖音伴随服务

该目录把本地验证过的 `jiji262/douyin-downloader` 改造固定为可复现的生产部署：

- 上游固定在 `c8ddfeb997c0fd8aec6480ed056bf84d265cc954`；
- `zhicui-sidecar.patch` 保存知萃需要的 50/100 条元数据同步、Web API、二维码登录与即时媒体流改造；
- 服务只监听 `127.0.0.1:9000`，Nginx 不对公网暴露；
- 浏览器运行在 Xvfb 虚拟显示器中，只把裁剪后的二维码交给已登录的知萃用户；
- Cookie 按知萃用户作用域保存到 `/opt/douyin-downloader/Metadata/.sessions/<scope>/cookies.json`，目录权限为 `0700`、文件权限为 `0600`；
- 资料库元数据同样按作用域保存在 `/opt/douyin-downloader/Metadata/.sessions/<scope>/library/`；
- 生产模式禁止下载持久视频；播放和 ASR 只临时流式读取，响应/处理结束立即释放。

## 安装或升级

代码已经部署到 `/opt/zhicui` 后执行：

```bash
sudo bash /opt/zhicui/deploy/douyin-sidecar/install.sh
```

安装器会创建一个新的不可变 release、应用补丁、安装 Python/Playwright/Chromium，并原子切换 `current` 软链接。Cookie 会保留；生产配置会强制更新为 `metadata_only`，并清除旧版本遗留的持久视频/音频文件。

## 运维

```bash
sudo systemctl status zhicui-douyin-sidecar
sudo journalctl -u zhicui-douyin-sidecar -f
curl --noproxy '*' http://127.0.0.1:9000/api/v1/health
```

更新配置后：

```bash
sudo systemctl restart zhicui-douyin-sidecar
```

不要把 9000 端口加入公网防火墙或 Nginx。扫码登录应始终通过知萃的鉴权接口 `/api/library/douyin/login*` 发起。

健康接口必须返回 `storage_mode: metadata_only`、`max_sync_count: 100` 和当前登录浏览器并发上限。登录默认允许 2 个不同用户并发，更多请求进入独立排队态，可用 `DOUYIN_LOGIN_BROWSER_CONCURRENCY` 在 1–4 之间调整；同一用户重复请求只复用一个任务。同步接口接受 1–100 条的精确整数范围；`/download` 与 `/crawl` 在生产模式返回 403。`DELETE /api/v1/cookies` 只清理当前作用域的抖音会话与二维码状态，不删除目录元数据或生成内容。

## 指定博主接口约定

知萃优先调用以下作用域隔离接口；返回值只能包含公开展示资料，禁止包含 Cookie、签名媒体 URL、文件路径或平台原始响应：

- `POST /api/v1/creators/resolve`：`{"profile_url":"https://www.douyin.com/user/<sec_user_id>"}`，返回 `creator_id / display_name / avatar_url`。
- `POST /api/v1/creators/works`：`{"creator_id":"<sec_user_id>","limit":50}`，返回 `items`，并把发现的作品登记到当前 `X-Zhicui-Scope` 的 metadata-only catalog，供即时 ASR 使用。

滚动升级期间，主服务会兼容当前固定补丁已有的 `POST /api/v1/auto-collect`：传入 `mode=post`、`url=官方博主主页` 和 `count=20|50|100`，完成后从当前作用域的 `/api/v1/items` 读取作品。两种路径都不会持久化视频。
