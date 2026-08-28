# 知萃 B站全量目录 sidecar

该目录把 yutto 作为独立 GPL-3.0 进程部署，仅使用其 `resolve.start` /
`item_listed` 能力枚举 B站公开投稿，不调用 `download.start`，也不把媒体、路径、
Cookie 或原始响应写入知萃数据库。

- 固定版本：`2.2.0`
- 固定源码：`ba90a95bd89e416059ee5559b52197531d5d8998`
- 监听：`ws://127.0.0.1:11223`，不得经 Nginx 或防火墙暴露
- 鉴权：`/opt/yutto-sidecar/server.token`，普通文件、`ubuntu:ubuntu`、`0600`
- 隔离：独立 venv、systemd 和源码目录；运行时 `/opt/yutto-sidecar` 只读，不链接进 FastAPI
- 启动闸门：`preflight.py` 校验固定版本、token 所有者/0600、许可证与运行目录；
  readiness 再执行带鉴权的 `server.info` 并要求完整 resolve/task 协议能力。

注意：已核验 PyPI 官方 `yutto-2.2.0-py3-none-any.whl` 的 SHA256 为
`d4a60283f88d64939c6828cef6ab2dfdd9d7ca33899524c0c33bef2d6b5eaeba`，但该
wheel 不包含固定提交新增的 `serve / resolve.start` 协议，因此安装器不会使用它；
安装器以校验过 SHA256 的 rustup 1.28.2
安装 Rust 1.85.0，并从上述固定提交构建，随后校验版本、依赖和 `serve` 子命令。
构建前还会应用仓库内可审计的 `zhicui-catalog-fields.patch`，仅把投稿发布时间
和总时长加入 resolve-only 的 `item_listed` 安全快照；补丁不增加下载调用。

## 安装、健康检查与开放门控

```bash
sudo bash /opt/zhicui/deploy/yutto-sidecar/install.sh
sudo systemctl enable --now zhicui-yutto-sidecar
sudo /opt/yutto-sidecar/.venv/bin/python /opt/yutto-sidecar/health_check.py
```

安装后服务默认保持关闭。健康检查必须返回 `healthy: true`、版本 `2.2.0`，然后
才能在后端 systemd 环境中显式设置并重启：

```bash
YUTTO_CATALOG_ENABLED=true
YUTTO_CATALOG_URL=ws://127.0.0.1:11223
YUTTO_CATALOG_TOKEN_FILE=/opt/yutto-sidecar/server.token
```

全局 Creator Sync 功能开关仍保持关闭；管理员完成抖音/B站连接器健康测试后，
再在管理端开启。回滚时先关闭 Creator Sync 开关和 `YUTTO_CATALOG_ENABLED`，
再执行 `sudo systemctl disable --now zhicui-yutto-sidecar`。

## 冒烟清单

1. 小账号：完整枚举，发现数与公开投稿数一致；选择 1 条后才出现转写任务。
2. 多作品账号：枚举过程中持续增长发现数，完成后总数确定，未下载任何媒体。
3. 多 P 投稿：目录中只出现一个 BVID，`parts` 按 P 顺序保存，勾选后由主服务合并文稿。
4. 取消：运行中的 `resolve` 进入 cancelled，已发现目录行保留且旧作品不被误标不可用。
5. 部分失败/风控：显示需用户处理或部分完成，不自动死循环，不清除旧目录状态。

许可证和对应源码位置见 `SOURCE-NOTICE.md`。
