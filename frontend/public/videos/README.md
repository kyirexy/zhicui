# 首页功能演示视频

当录屏准备好后，建议使用以下文件名：

- `blogger-selection.mp4`：定向整理博主视频
- `blogger-selection-poster.webp`：上述视频封面
- `blogger-selection.zh-CN.vtt`：上述视频中文字幕
- `multi-video-qa.mp4`：多选视频集中提问
- `multi-video-qa-poster.webp`：上述视频封面
- `multi-video-qa.zh-CN.vtt`：上述视频中文字幕

将文件放入本目录后，在 `frontend/src/components/WebLandingPage.tsx` 的
`PRODUCT_STORIES` 中填写对应的 `videoSrc`、`posterSrc` 和 `captionsSrc`。

根目录默认忽略 `videos/`，加入真实媒体时请显式执行
`git add -f frontend/public/videos/<文件名>`，避免本地可播放但正式环境缺少资源。

建议导出 H.264 MP4，1080p，单条尽量控制在 20 MB 以内。页面使用
`preload="none"`，不会在用户点击前下载完整视频。
