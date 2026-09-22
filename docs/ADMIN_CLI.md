# 管理端 CLI

`scripts/admin_cli.py` 是管理端的 API CLI。它调用与网页管理端相同的
`/api/admin/*` 接口，因此会继续使用管理员权限、参数校验和审计日志。它不
直接打开数据库，也不绕过生产鉴权。根目录 `cli/` 仍然是普通用户的
`zhicui` CLI，两者的权限边界保持分离。

## 快速使用

令牌通过环境变量或标准输入提供，不放在命令行参数中：

```powershell
$env:ZHICUI_ADMIN_TOKEN = '<从受控密钥存储注入>'
python scripts/admin_cli.py --non-interactive stats
python scripts/admin_cli.py --non-interactive users-list --query page=1 --query per_page=50
python scripts/admin_cli.py --non-interactive readiness --query refresh=true
```

生产地址默认是 `https://luxai.cn`。本地开发可以设置
`ZHICUI_ADMIN_URL=http://127.0.0.1:8000`；远程地址必须使用 HTTPS。需要一次
性读取令牌时可使用 `--token-stdin`（此时请求体请用 `--body-file`，避免和
令牌共用标准输入）：

```powershell
Get-Content .admin-token -Raw | python scripts/admin_cli.py --token-stdin --non-interactive ops
```

## 查询与修改

每个管理端点都有对应快捷命令，完整列表可用 `python scripts/admin_cli.py
--help` 查看。修改请求的 JSON 可以放在文件或标准输入中，避免密钥进入
PowerShell 历史记录：

```powershell
python scripts/admin_cli.py llm-config-put --body-file .\llm-config.json
python scripts/admin_cli.py users-update <user-id> --body-file .\user-patch.json
```

删除用户、资料、计划、聊天模型、官网案例、视觉 Provider/方案和批量删除等
破坏性命令必须显式添加 `--yes`。重置密码也需要 `--yes`：

```powershell
python scripts/admin_cli.py notes-delete <note-id> --yes
python scripts/admin_cli.py users-reset-password <user-id> --body-file .\password.json --yes
```

需要覆盖新增或暂未有快捷命令的管理接口时，使用通用命令；路径被限制在
`/api/admin/`：

```powershell
python scripts/admin_cli.py request GET /api/admin/operational-alerts --query refresh=true
python scripts/admin_cli.py request PATCH /api/admin/feedback/<id> --body-file .\feedback.json
```

交流群二维码上传也走通用命令的 multipart 支持：

```powershell
python scripts/admin_cli.py request PUT /api/admin/community-qr --file .\qr.png --expires-at 2026-12-31
```

官网案例草稿媒体和海报可以保存到本地；二进制接口必须显式提供输出文件：

```powershell
python scripts/admin_cli.py showcase-media <case-id> --output .\case.mp4
python scripts/admin_cli.py showcase-poster <case-id> --output .\case.jpg
```

上传案例媒体使用同一个受保护的 multipart 接口：

```powershell
python scripts/admin_cli.py showcase-media-upload <case-id> --file .\case.mp4
```

CLI 输出始终是 JSON。`api_key`、Token、Cookie、密码、JWT、secret 等字段会
被替换成 `***redacted***`，不会输出到终端或 CI 日志。服务端返回错误时只
显示安全的错误摘要。

## 验证

```powershell
python -m py_compile scripts/admin_cli.py
python scripts/test_admin_cli.py
```
