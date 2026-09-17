# HYPIT-RUNBOOK:创作工坊(Hypit)服务器环境

「创作工坊」(桌面端 `/studio`)在后端 spawn `hypit` CLI 完成渲染。本文记录腾讯云服务器的
一次性安装、常驻 Runtime、后端开关与冒烟步骤。默认**全链路关闭**:`HYPIT_ENABLED=false`
时管理端配置不生效、API 一律 503。

## 0. 许可红线(先读)

Hypit 为 Apache-2.0 + 附加条款:

- 单租户自用免费;**捆绑进收费产品或对外多租户服务前,必须完成 Hypit.AI 商业授权沟通**。
- 面向用户的 run report / manifest 派生界面不得移除 Hypit 名称、LOGO 与版权声明(附加条款 1c)。
- 生成的视频内容归用户。

## 1. 系统依赖

```bash
# Node ≥ 22.15(nvm 安装,勿用 apt 的旧版 nodejs)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22 && nvm alias default 22
node -v        # 必须 ≥ 22.15

# ffmpeg + ffprobe
sudo apt-get install -y ffmpeg
ffmpeg -version | head -1 && ffprobe -version | head -1

# hypit CLI
npm install -g @hypit/hypit
hypit --version
hypit doctor   # 全绿才继续
```

## 2. 常驻 Runtime(systemd `zhicui-hypit-runtime`)

```bash
hypit runtime init       # 生成 runtime profile,按提示选择 media/hyperframes 的 *.local 覆盖
```

profile 必须满足(服务器无 GPU、内存有限):

- `workers: 1` —— 渲染吃内存,**严禁并发**;后端 DB 队列本身也是串行消费,双保险。
- `browserGpu: software` —— Chrome Headless 走软件渲染。
- 启用 `@hypit/credential-store-env` —— 后端以环境变量传 HypiHub key(见 §3)。

`/etc/systemd/system/zhicui-hypit-runtime.service`:

```ini
[Unit]
Description=Zhicui Hypit runtime worker
After=network.target

[Service]
User=ubuntu
ExecStart=/home/ubuntu/.nvm/versions/node/v22.x.x/bin/hypit runtime up
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now zhicui-hypit-runtime
systemctl status zhicui-hypit-runtime
```

## 3. 后端开关与凭据

`videocapsule-backend` 的环境(drop-in 或 .env):

```bash
HYPIT_ENABLED=true                 # 总开关;默认 false(fail-closed)
HYPIT_CLI_PATH=/home/ubuntu/.nvm/versions/node/v22.x.x/bin/hypit
                                   # systemd 环境 PATH 不含 nvm bin,必须绝对路径
HYPIT_PROJECT_ROOT=/opt/zhicui/hypit-projects
HYPIT_RESULT_MAX_TOTAL_MB=2048     # 产物目录总量守护
HYPIT_RESULT_MIN_FREE_MB=1024      # 磁盘剩余空间下限
HYPIT_BUILD_TIMEOUT_MINUTES=40     # 单次渲染超时
```

HypiHub API key **不进 .env**:管理端 → 系统设置 → 创作工坊 → 填入 Key,经 Fernet 加密
落 `system_settings`(`hypihub_api_key`);后端每次 spawn 子进程时以 `HYPIHUB_API_KEY`
环境变量注入,凭据不落盘、不进 URL。管理员副开关(`hypit_enabled`)与
`HYPIT_ENABLED` 同时开启才对用户可见。

## 4. 资源前置检查(必须)

```bash
free -h    # 可用内存 < 4 GiB → 一期限定短时长(≤30s)/720p,或升配后再放开
df -h /opt # 需 ≥ 4.5 GiB 余量;deploy preflight 已上调 BUILD_RESERVE=4608MiB
```

跑一个**纯代码渲染(零生成)**的最小项目实测峰值内存与时长,确认 Runtime 正常:

```bash
mkdir -p /tmp/hypit-smoke && cd /tmp/hypit-smoke
# 写入最小 main.svml + render.svrun 后:hypit build <run-id> --follow --json
```

## 5. 冒烟清单

1. `hypit doctor` 全绿;`systemctl status zhicui-hypit-runtime` active。
2. 管理端开副开关 → 桌面端出现「创作工坊」tab → 提交需求 → drafting → draft。
3. 确认渲染 → queued → rendering → completed → `<video>` 可播放、下载可用。
4. 迭代:draft 下提交修改 → 回到 drafting → 新 draft。
5. 取消:rendering 中点取消 → cancelled(Runtime 侧 build 同步取消)。
6. 重启恢复:`sudo systemctl restart videocapsule-backend`,rendering + build_id 的 job
   自动恢复轮询;无 build_id 的置为 failed。
7. 开关回退:管理端关副开关 → 用户端立即 503(`创作工坊已由管理员暂停`)。

## 6. 故障排查

- 后端 worker 日志:`sudo journalctl -u videocapsule-backend -f | grep -i video-creation`
- 渲染侧日志:`sudo journalctl -u zhicui-hypit-runtime -f`、`hypit logs <build-id>`
- 「服务器渲染组件尚未就绪」:`which hypit` 以**后端运行用户**执行——systemd PATH 不含
  nvm 时,`HYPIT_CLI_PATH` 必须给绝对路径。
- 磁盘增长:`du -sh /opt/zhicui/hypit-projects/* | sort -h`;超
  `HYPIT_RESULT_MAX_TOTAL_MB` 时 worker 会在下次导出前自动最旧先清(仅终态 job)。
- 队列滞留:`psql zhicui -c "SELECT id,status,updated_at FROM video_creation_jobs ORDER BY updated_at DESC LIMIT 10;"`
