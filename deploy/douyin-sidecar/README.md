# 知萃抖音伴随服务

该目录把本地验证过的 `jiji262/douyin-downloader` 改造固定为可复现的生产部署：

- 上游固定在 `c8ddfeb997c0fd8aec6480ed056bf84d265cc954`；
- `zhicui-sidecar.patch` 保存知萃需要的收藏顺序、Web API、二维码登录与视频列表改造；
- 服务只监听 `127.0.0.1:9000`，Nginx 不对公网暴露；
- 浏览器运行在 Xvfb 虚拟显示器中，只把裁剪后的二维码交给已登录的知萃用户；
- Cookie 保存为 `/opt/douyin-downloader/.cookies.json`，权限为 `0600`；
- 视频与清单保存在 `/opt/douyin-downloader/Downloaded/`，不写入知萃 PostgreSQL。

## 安装或升级

代码已经部署到 `/opt/zhicui` 后执行：

```bash
sudo bash /opt/zhicui/deploy/douyin-sidecar/install.sh
```

安装器会创建一个新的不可变 release、应用补丁、安装 Python/Playwright/Chromium，并原子切换 `current` 软链接。已有 Cookie、配置、视频和数据库不被删除。

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
