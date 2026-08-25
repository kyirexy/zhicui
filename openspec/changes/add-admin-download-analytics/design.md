## Context

官网、桌面侧栏、设置页和二维码目前直接指向 `/download/zhicui.apk` 或 Windows 安装包静态 URL。Nginx 静态分发不会进入 FastAPI，现有 `/api/admin/stats` 因而没有下载数据。项目使用 SQLAlchemy `create_all` 启动建表，并要求 SQLite/PostgreSQL 兼容。

## Goals / Non-Goals

**Goals:**

- 可靠记录用户实际发起的 Android/Windows 客户端下载请求。
- 用固定大小的日聚合数据支持管理端快速查询。
- 不采集可识别下载者的请求信息。
- 保持静态文件由现有 Web 服务器高效分发。

**Non-Goals:**

- 不判断安装是否完成、应用是否首次启动或下载字节是否完整。
- 不做用户级归因、渠道投放归因或设备指纹。
- 不改变客户端更新检查协议和安装包内容。

## Decisions

1. 新增公开 `GET /api/client-downloads/{platform}` 入口。入口验证平台、原子递增当天聚合行后，使用 307/302 重定向到服务端白名单中的静态文件，而不是接受任意目标 URL，避免开放重定向。
2. 使用 `client_download_daily` 表，以 `date + platform` 唯一约束保存 `count`。相比逐次事件表，它不会随下载量无限增长，也天然满足当前总量和趋势需求。
3. 并发递增使用数据库方更新；首次写入遇到唯一键竞争时回滚并重试更新，兼容 SQLite 与 PostgreSQL，不依赖方言专用 upsert。
4. `/api/admin/stats` 增加 `downloads` 对象，包含 `total`、`today`、`last_7_days`、`by_platform` 与最近 14 天 `daily`。旧字段保持不变。
5. 所有公开下载入口和二维码改指计数 URL；计数发生在下载请求到达后，而不是页面按钮渲染或普通点击埋点。

## Risks / Trade-offs

- [Risk] 重复点击、下载器重试会被计为多次下载 → 指标明确命名为“下载次数/下载启动”，不声称为唯一用户或安装量。
- [Risk] 数据库短暂不可用会阻止下载 → 计数失败时记录日志并仍重定向到静态文件，优先保证用户可下载。
- [Risk] 外部仍保存旧静态链接会绕过统计 → 应用内链接全部迁移；旧链接继续可用但管理端提示这是可观测下载次数。

## Migration Plan

1. 部署后端模型和接口，启动时自动创建聚合表。
2. 部署前端计数链接与管理端卡片。
3. 验证两个平台重定向与管理端增量后开放使用。
4. 回滚时恢复前端静态链接；保留聚合表不会影响旧版本。

## Open Questions

无。
