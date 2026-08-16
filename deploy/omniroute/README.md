# 知萃 OmniRoute 网关

该模板从 `integrations/OmniRoute` 的固定源码构建网关，并且默认只监听服务器回环地址。普通用户不直接访问 OmniRoute 管理面板，知萃 FastAPI 通过 `http://127.0.0.1:20128/v1` 调用它。

Compose 会直接运行上游的 standalone Node 入口，以兼容 Windows Git 将 shell 脚本检出为 CRLF 的情况；不需要修改 OmniRoute 子模块源码。

## 启动

```bash
cd deploy/omniroute
cp .env.example .env
# 替换 .env 中的全部密钥和管理密码
docker compose up -d --build
docker compose ps
```

默认构建上游 `runner-base`，包含完整网关、模型目录和管理控制台，但不额外安装
Codex、Claude Code、OpenClaw 等服务器不需要的 CLI，可减少镜像体积与首次构建时间。

验证 OpenAI 兼容接口：

```bash
curl http://127.0.0.1:20128/v1/models \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY"
```

然后在知萃后端 `.env` 配置：

```dotenv
OMNIROUTE_API_BASE=http://127.0.0.1:20128/v1
OMNIROUTE_API_KEY=<与网关一致的访问密钥>
OMNIROUTE_MODEL=auto
```

重启知萃后端后，用户设置中的“OmniRoute 智能路由”会变为可选。

## 管理面板

端口没有向公网开放。需要配置 OmniRoute 上游供应商时，在本机建立 SSH 隧道：

```bash
ssh -L 20128:127.0.0.1:20128 ubuntu@124.223.193.227
```

再打开 `http://127.0.0.1:20128`。不要为管理面板新增公开 Nginx 路由。

## 停止与回滚

```bash
docker compose down
```

清空知萃后端的 `OMNIROUTE_API_BASE` 和 `OMNIROUTE_API_KEY` 后重启；已经选择 OmniRoute 的用户会自动回退到知萃基础 AI。数据卷默认保留，只有明确需要清空网关数据时才单独删除。
