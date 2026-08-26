# 知萃抖音伴随服务

该目录把本地验证过的 `jiji262/douyin-downloader` 改造固定为可复现的生产部署：

- 上游固定在已回归验证且与部署补丁一致的 `c8ddfeb997c0fd8aec6480ed056bf84d265cc954`；
- `zhicui-sidecar.patch` 保存知萃需要的近期/全量 metadata-only 同步、Web API、二维码登录与即时媒体流改造；
- `private-list-hardening.patch` 在同一 sidecar 内增加喜欢列表 WebSign 请求、收藏登录条件预检与结构化风控错误，不启动第二套抖音服务；
- 服务只监听 `127.0.0.1:9000`，Nginx 不对公网暴露；
- 浏览器运行在 Xvfb 虚拟显示器中，只把裁剪后的二维码交给已登录的知萃用户；
- Cookie 按知萃用户作用域保存到 `/opt/douyin-downloader/Metadata/.sessions/<scope>/cookies.json`，目录权限为 `0700`、文件权限为 `0600`；
- 资料库元数据同样按作用域保存在 `/opt/douyin-downloader/Metadata/.sessions/<scope>/library/`；
- 生产模式禁止下载持久视频；播放和 ASR 只临时流式读取，响应/处理结束立即释放。
- 收藏同步采用 API 优先、后台 Chromium XHR 单次回退；双通道受限后按用户作用域熔断，默认从 15 分钟退避到最多 6 小时，不弹出用户可见网页。
- 喜欢与收藏不会再把 `403`、验证码、缺失 `UIFID` 或异常响应伪装成“成功同步 0 条”；只有平台明确返回成功且带列表字段时，空列表才算真实空结果。

## 安装或升级

代码已经部署到 `/opt/zhicui` 后执行：

```bash
sudo bash /opt/zhicui/deploy/douyin-sidecar/install.sh
```

安装器会创建一个新的不可变 release、应用补丁、安装 Python/Playwright/Chromium，并原子切换 `current` 软链接。Cookie 会保留；生产配置会强制更新为 `metadata_only`，并清除旧版本遗留的持久视频/音频文件。

安装器还会安装 Node.js，并预取、校验固定 SHA-256 的抖音 SecSDK 运行文件。校验失败会阻止版本切换，避免运行未经验证的远端脚本。

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

`GET /api/v1/cookies` 会额外返回不含敏感值的 `private_list_readiness`：`like_ready`、`collection_ready` 与 `missing_requirements`。喜欢只要求有效登录会话；收藏还要求登录流程最终生成 `UIFID`，`UIFID_TEMP` 不视为就绪。主服务应在发起同步前使用该结果，并把 `argus_uifid_missing`、`risk_controlled`、`verification_required`、`session_expired` 等安全错误码展示成可执行提示。

日志只允许记录接口路径、HTTP 状态、错误分类、耗时和条目数量；不得输出 Cookie、查询串、签名 URL、媒体地址或平台原始响应。

健康接口必须返回 `storage_mode: metadata_only`、`max_sync_count: 100`、`supports_creator_catalog: true`、包含 `creator_catalog` 与 `collection_resilience` 的 `capabilities` 和当前登录浏览器并发上限。登录默认允许 2 个不同用户并发，更多请求进入独立排队态，可用 `DOUYIN_LOGIN_BROWSER_CONCURRENCY` 在 1–4 之间调整；同一用户重复请求只复用一个任务。同步接口接受 1–100 条的精确整数范围；`/download` 与 `/crawl` 在生产模式返回 403。`DELETE /api/v1/cookies` 只清理当前作用域的抖音会话与二维码状态，不删除目录元数据或生成内容。

## 私有列表上线冒烟

升级 sidecar 后，使用测试账号对应的作用域执行以下检查。占位符只用于命令行输入，不要把真实作用域、Cookie 或完整响应写入工单和日志。

1. `GET /api/v1/cookies` 应返回 `valid=true` 和 `private_list_readiness`；响应中不得出现 Cookie 值。
2. `mode=like` 发起 5 条 metadata-only 同步，轮询任务直到结束。平台明确返回列表时允许成功；403、验证码和异常结构必须返回错误码，不能显示“成功 0 条”。
3. 若 `collection_ready=false`，`mode=collection` 必须立即返回 `409 / argus_uifid_missing`，同时喜欢同步仍能启动。
4. 重新扫码并等待登录确认后再次读取 readiness；只有最终 `UIFID` 到位才允许收藏任务进入队列。
5. 用确认为空的测试账号检查真实空列表：只有上游 `status_code=0` 且存在空的 `aweme_list` 时才可完成为 0 条，并保留旧目录。
6. 检查 `journalctl -u zhicui-douyin-sidecar`：日志只能包含路径、状态、分类、耗时和数量，不得包含 Cookie、签名查询串或媒体地址。

## 指定博主接口约定

知萃优先调用以下作用域隔离接口；返回值只能包含公开展示资料，禁止包含 Cookie、签名媒体 URL、文件路径或平台原始响应：

- `POST /api/v1/creators/resolve`：`{"profile_url":"https://www.douyin.com/user/<sec_user_id>"}`，返回 `creator_id / display_name / avatar_url`。
- `POST /api/v1/creators/works`：`{"creator_id":"<sec_user_id>","limit":50}`，返回 `items`，并把发现的作品登记到当前 `X-Zhicui-Scope` 的 metadata-only catalog，供即时 ASR 使用。
- `POST /api/v1/creators/catalog`：`{"creator_id":"...","cursor":null,"page_size":50,"metadata_only":true}`，逐页返回安全元数据、`catalog_id / next_cursor / has_more / total_count / complete / needs_action`；不登记或下载媒体。
- `DELETE /api/v1/creators/catalog/{catalog_id}`：只取消当前 `X-Zhicui-Scope` 的全量任务；API 分页受限时尝试无媒体浏览器回退，遇到验证码/风控则返回 `needs_action`，不自动死循环。

滚动升级期间，主服务会兼容当前固定补丁已有的 `POST /api/v1/auto-collect`：传入 `mode=post`、`url=官方博主主页` 和 `count=20|50|100`，完成后从当前作用域的 `/api/v1/items` 读取作品。两种路径都不会持久化视频。
