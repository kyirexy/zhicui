## 1. 服务端本地来源快照

- [x] 1.1 新增用户隔离的 `douyin_local_library_items` 模型、启动迁移和安全序列化
- [x] 1.2 实现最多 100 条本地作品的字段校验、canonical URL 规范化、幂等快照与来源台账写入
- [x] 1.3 新增 JWT 保护的本地抖音 metadata ingest API 和低敏活动记录
- [x] 1.4 将本地快照与旧 sidecar manifest 合并到抖音列表、详情和批量文稿 item 解析
- [x] 1.5 让本地快照作品通过 canonical 单视频链接完成临时媒体解析和现有文稿提取

## 2. Windows 本地抖音连接器

- [x] 2.1 扩展 Electron contract、运行时类型和安全校验，加入 `douyin` provider、公开 metadata item 与 1–100 数量
- [x] 2.2 将抖音登录迁移到按知萃用户隔离的持久 Chrome/Edge profile，并保留旧 handoff 兼容入口
- [x] 2.3 实现官方主页作品/喜欢/收藏标签的有限滚动、网络响应采集和 DOM 降级
- [x] 2.4 实现后台最小化同步、按需前台验证、取消、断开连接和不含敏感值的状态事件
- [x] 2.5 扩展主进程、preload bridge 和 capability contract，拒绝不可信 IPC 与越界请求

## 3. 前端同步体验

- [x] 3.1 扩展桌面运行时与 API 类型，新增本地抖音 metadata ingest 调用
- [x] 3.2 在视频资料页优先使用 Windows 本地抖音连接器，旧客户端保留云端兼容路径
- [x] 3.3 在全局同步 Sheet 中复用相同本地抖音流程并保持后台任务反馈
- [x] 3.4 将状态文案改为“本机登录有效/正在本机读取/需要官方验证”，提供 20/50/100 与自定义数量且保持纯手动
- [x] 3.5 验证桌面、Web、Android 能力分支、键盘可用性、错误就近显示和安全区布局

## 4. 验证与回归

- [x] 4.1 增加后端用户隔离、幂等、字段拒绝、来源合并和本地 item 文稿提取测试
- [x] 4.2 扩展桌面 contract/连接器测试，覆盖持久会话、来源选择、去重、数量上限、取消和敏感字段不外泄
- [x] 4.3 扩展前端同步测试，覆盖 bridge 能力切流、旧客户端兼容、逐步计数和失败提示
- [x] 4.4 运行目标 unittest、桌面 typecheck/verify、前端测试与 Next.js production build

## 5. 发布与正式部署

- [x] 5.1 提升桌面版本并生成、核验 Windows 安装包、blockmap 与 `latest.yml`
- [ ] 5.2 提交并推送 GitHub/Gitee，等待 Jenkins 部署兼容后端和 Web，再原子发布 Windows 更新源
- [ ] 5.3 验收 luxai.cn 构建版本、生产 API、桌面更新清单和服务健康，并用本地连接器执行一次受控冒烟
