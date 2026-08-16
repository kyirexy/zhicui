# XHS-Downloader sidecar 部署

知萃通过本机 HTTP 调用固定版本的 XHS-Downloader，不把 GPL-3.0 上游代码
导入主 FastAPI 进程。sidecar 默认监听 `127.0.0.1:5556`，Nginx 不应对公网
暴露该端口。

## 首次安装

```bash
sudo bash /opt/zhicui/deploy/xhs-downloader/install.sh
```

安装器会校验固定上游提交、幂等应用 `zhicui-creator.patch`，然后安装依赖、
注册 systemd 服务并执行 loopback 健康检查。上游提交变化时会拒绝套用旧补丁，
必须先完成许可证与接口回归验证。

在 `/opt/zhicui/.env` 中设置：

```dotenv
XHS_DOWNLOADER_API_BASE=http://127.0.0.1:5556
XHS_DOWNLOADER_TIMEOUT_SECONDS=20
XHS_COOKIE=从已登录的小红书网页版取得的 Cookie
```

Cookie 只由知萃后端随单次 `/xhs/detail` 请求传给 sidecar。不要把真实值写入
仓库、Jenkins 控制台、systemd unit 或前端环境变量。

指定博主同步还要求 sidecar 提供两个 loopback-only 接口：

- `POST /xhs/creator`：接收 `profile_url / cookie / download=false`，只返回 `creator_id / display_name / avatar_url`。
- `POST /xhs/creator/works`：接收 `creator_id / limit / cookie / download=false`，只返回最近公开作品的规范化元数据。

第二个接口必须在 sidecar 内过滤或标注作品类型；知萃主服务会再次硬性过滤，只接收视频笔记。响应和日志禁止回显 Cookie、签名媒体地址、base64、文件路径或小红书原始响应。GPL-3.0 上游继续作为独立进程分发；部署时必须保留许可证、固定源码版本并提供对应源码说明。

## 验证与运维

```bash
curl -I http://127.0.0.1:5556/
sudo systemctl status xhs-downloader
sudo journalctl -u xhs-downloader -f
```

更新主仓库后，`deploy/deploy.sh` 会同步固定的子模块提交。若该提交发生变化，
在独立验证后重新运行 `.venv/bin/pip install -e .` 并重启 sidecar。没有启动
sidecar 时知萃仍可导入部分小红书正文，但会在资料卡上标记降级状态。
