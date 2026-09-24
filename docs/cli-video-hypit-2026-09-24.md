# CLI 视频素材交接（2026-09-24）

## 本次能力

基础接入明确增加 `library.import_link`、`library.transcript.generate` 和安全直连 `library.media.download`，共 41 个 Action、11 项权限。仅导入用户指定的抖音或 B站公开视频，不自动同步账号列表。旧令牌不自动获得 `library:write`。

CLI 1.0.4 新增：

```powershell
zhicui auth login --scopes library:read,library:write
zhicui library prepare https://v.douyin.com/MXcIo7LVWSA/ --output D:\hypit-projects\guga-remake\source-package --timeout 20m --jsonl
# 中断后使用相同目录和链接，显式追加 --resume
zhicui library download <note_id> --output D:\videos\source.mp4 --timeout 10m --jsonl
```

准备目录包含 `source.mp4`、有音频时的 `transcript.txt` 和带 SHA-256 的 `manifest.json`；不包含令牌、Cookie 或上游临时播放地址。文件完成验证后才发布，不覆盖已有文件。明确无音频的视频仍可完成素材交接，清单如实标记 `no_audio`。恢复不会重新执行已完成的步骤。

## 范围和限制

- PAT 需要 `library:read` 与 `library:write`，通过设备授权或页面创建，秘密只进入凭据存储。
- 抖音分享短链作为经过严格校验的公开来源保留，资料身份仍为稳定视频 ID；每次媒体解析都核对 ID。
- 下载仅访问允许的 HTTPS 公网 CDN，逐跳固定 DNS、校验证书，不转发用户凭据，最大 512 MB。
- B站非第一分 P 暂明确拒绝，以免既有资料身份丢失分 P 信息后返回错误视频。
- 平台要求登录或验证时停止，不自动重试或导出浏览器 Cookie。
- Hypit 素材清单完成不代表动画复刻完成。当前本机 Hypit 仅配置本地处理与渲染，生成新动画仍需单独连接视频模型服务。

## 发布前验证

- 后端全量 880 项通过，1 项按环境跳过；收尾媒体定向 37 项、core/清单 42 项通过。
- 前端生产构建、接入页面与连接提示词测试通过。
- CLI 新增 11 项测试通过，覆盖重定向拒绝、无覆盖、哈希恢复、杀进程恢复、权限不足及无音频。
- CLI 全套 111 项中 108 项首遍通过，3 项既有进程探测测试遇本机启动超时；保持原阈值单独重跑后 3 项全部通过。
- 服务器使用真实抖音来源进行下载预检，得到 5,948,588 字节 MP4。预检不使用用户 Cookie 或令牌，不写用户资料库。
- 正式发布仍使用同提交 dark、加密备份恢复双启动、core 晋级与真实鉴权冒烟；正式结果另行记录，不能以本地验证代替。
