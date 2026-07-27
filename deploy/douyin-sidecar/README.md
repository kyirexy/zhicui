# 知萃抖音伴随服务

该目录把本地验证过的 `jiji262/douyin-downloader` 改造固定为可复现的生产部署：

- 上游固定在 `c8ddfeb997c0fd8aec6480ed056bf84d265cc954`；
- `zhicui-sidecar.patch` 保存知萃需要的 50/100 条元数据同步、Web API、二维码登录与即时媒体流改造；
- 服务只监听 `127.0.0.1:9000`，Nginx 不对公网暴露；
- 浏览器运行在 Xvfb 虚拟显示器中，只把裁剪后的二维码交给已登录的知萃用户；
- Cookie 保存为 `/opt/douyin-downloader/.cookies.json`，权限为 `0600`；
- 资料库元数据保存在 `/opt/douyin-downloader/Metadata/`；
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

健康接口必须返回 `storage_mode: metadata_only` 和 `max_sync_count: 100`。同步接口接受 1–100 条的精确整数范围；`/download` 与 `/crawl` 在生产模式返回 403。`DELETE /api/v1/cookies` 只清理抖音会话与二维码状态，不删除目录元数据或生成内容。
