# 音频提取与发布素材（2026-10-04）

新增 Web 视频下载页“提取音频 MP3”和 `zhicui audio <链接>`（CLI 1.0.13）。`download --audio` 与 `resolve --audio` 同样可用；MCP/Action `library.media.resolve` 新增可选 kind=audio，默认视频行为保持兼容。

入口继续绑定当前用户与凭证，有效五分钟；解析不下载视频。音频请求在下载阶段读取经过域名、DNS、重定向、体积和期限校验的媒体，B站分离轨道优先读取音轨。FFmpeg 仅接收已验证的本地容器，禁用网络协议，以192kbps MP3输出。转换前后保持并发限制，响应结束、断连、转换失败及授权吊销时清理临时文件。无音轨返回 NO_AUDIO / 无音频。下载的是完整原声（可能包含人声、配乐、音效），不是背景音乐分离。

本地验证：CLI 134项测试，Web下载9项测试、TypeScript与生产构建通过。后端覆盖真实FFmpeg音轨提取、无音轨、伪装播放列表、用户隔离、B站音轨优先、临时文件清理及授权复查。能力清单摘要根据已审核的新参数更新；没有放宽Action或权限白名单。

视频交付在本地 `videos/zhicui-remotion/out/choice-theater-v2/`：91秒问句开场版、3:4与4:3封面、发布文案、SRT和口播。无背景音乐，无叮声。用户要求发布前预览和自行添加配乐，因此不会自动发布。

上线与真实下载结果另附后续记录。内置浏览器控制连接中断期间，不能声称已在抖音上传或填表。

正式发布与实测：

- 应用提交 `cfcda487373dc1a2b79a2fb0d4b8708e864c2fa7`。首次 Jenkins 314 在最后 checkout 快进时遇到目录组权限错误并回滚；315 因残留的受控变更拒绝启动。逐文件核对残留字节均属于目标提交，保存恢复补丁后清理，仅修复 `/opt/zhicui/cli/site` 和 `/opt/zhicui/frontend/src/app/video-download` 对既有可信构建组的写权限；未执行 root Git、未覆盖未知改动。
- Jenkins 316 dark 成功；同一备份的隔离恢复、双启动演练和临时库清理通过，证据 `agent-schema-rehearsal-20261004T140402Z-cfcda487373d.json`。随后 `manual-audio-core-cfcda48` 正式发布完成；认证、权限、下载哈希、真实 AI SSE、PAT/MCP 与完整旅程闸门通过。临时冒烟密码已恢复，租约已删除。正式接口为 core。
- 公网前端 build marker：`cfcda487373d-20261004140745`；Web 入口 `https://luxai.cn/video-download`。浏览器连接仍不可用，Web 按钮由生产构建与 HTTP/流读取测试覆盖，不声称已完成用户浏览器点击验收。
- 后端52项、CLI134项、Web媒体9项测试通过；真实 FFmpeg 提取和解码通过。
- CLI 1.0.13 官网包：GitHub run `37206237326`，标签 `cli-v1.0.13`，来源签名核验通过。官网 `https://luxai.cn/cli.tgz` 已更新，公网回读 SHA-256 `4fa2e0985f1b0d42fd94280a77c07fec407dd9e7ee3b6c3e0dc42c7abd6a23b5`，82041字节。npm发布工作流已取消，未声称npm仓库上架。当前电脑和Codex受管Skill已更新。
- 真实命令 `zhicui audio https://www.douyin.com/video/7691850536207456714` 成功：入口解析449ms，输出3465261字节，144.335秒、48kHz双声道MP3；完整解码通过。原声包含参考视频的人声和配乐，不是分离BGM。文件位于 `output/choice-publish-20261004/月老算法参考-原声.mp3`。
- 之前指定的抖音科技作品 `7691264293023029174` 在本次单次尝试仍返回 PLATFORM_UNAVAILABLE，未返回可下载媒体；未连续重试，未伪造其BGM。
- 成片、封面和文案已完成。内置浏览器连接中断，抖音发布参数目前只保存在本地，没有上传，没有点击发布；待连接恢复后继续填写并交给用户预览/添加配乐。
