## 1. 数据与依赖

- [x] 1.1 新增视频分析 Provider、Offering、账户、只追加账本、Run/Item、结果缓存与用户视觉 BYOK 模型
- [x] 1.2 注册模型并补充 SQLite/PostgreSQL 启动迁移、默认关闭设置和 PySceneDetect/OpenCV 生产依赖

## 2. 目录与账务服务

- [x] 2.1 实现 Provider/Offering 版本、发布校验、推荐目录、健康测试和安全序列化
- [x] 2.2 实现用户账户、管理员萃点调整、免费额度、服务端报价快照和缓存预检
- [x] 2.3 实现幂等确认、原子预留、逐项 capture/release/refund 和平台微元成本记录

## 3. 解析管线与持久任务

- [x] 3.1 实现媒体资格与安全临时下载、PySceneDetect AdaptiveDetector、均匀降级和关键帧预算
- [x] 3.2 实现 local_scene、图片 VLM 驱动接口、视觉 BYOK 失败关闭、原生视频占位能力校验
- [x] 3.3 实现结构化结果、时间码视觉证据、现有摘要安全合并、缓存复用与临时文件清理
- [x] 3.4 实现持久后台执行器、并发限制、取消、部分成功、重启重新排队与卡死预留释放

## 4. 用户与管理 API

- [x] 4.1 实现 catalog、prepare、confirm、运行查询、active/recent、取消和账户用户 API
- [x] 4.2 实现独立用户视觉 Provider CRUD 与真实图片连接测试 API
- [x] 4.3 实现管理 Provider/Offering CRUD、测试、发布、停用、运行/用量/成本/账本和用户萃点 API

## 5. 用户交互

- [x] 5.1 补充前端类型、API 客户端和全局活动任务轮询状态，不增加永久导航
- [x] 5.2 在现有视频摘要区域实现渐进推荐入口、免费直启、收费/BYOK 报价 Sheet 和完成状态
- [x] 5.3 在现有资料库更多批量操作实现跨平台视频筛选、批量报价、后台进度和逐项结算反馈
- [x] 5.4 在 AppHeader 活动时显示临时“解析中 N”入口并复用全局 Sheet，支持离页恢复与移动端可访问性
- [x] 5.5 在现有设置中实现独立视觉 BYOK 配置与测试，不复用文字 LLM 凭证

## 6. 管理端交互

- [x] 6.1 将现有 LLM 配置区扩展为 AI 模型配置并加入 Provider/Offering/风控列表与右侧编辑抽屉
- [x] 6.2 在现有用户详情和用量日志区域加入萃点调整、解析运行、收入、成本、失败与退款信息

## 7. Agent Tool

- [x] 7.1 实现受控 analyze_video_details 服务端工具、来源快照校验、缓存/免费单条策略和自动化硬禁止
- [x] 7.2 实现 approval_required/analysis_started SSE 终态、独立审批接口、拒绝文本回答和任务完成后原问题恢复
- [x] 7.3 在现有 Agent 消息流实现审批卡、方案切换、后台工具状态与“AI 画面观察 · 时间码”证据展示

## 8. 验证与上线保护

- [x] 8.1 使用现有 unittest 覆盖非自动触发、报价版本、幂等预留、成功/部分/失败结算、缓存、BYOK 和恢复
- [x] 8.2 验证 API/SSE/日志不暴露密钥、Cookie、媒体 URL、base64 或临时路径，并验证普通链路零视觉调用
- [x] 8.3 运行后端相关 unittest 与 frontend npm run build，修复回归并记录默认关闭和分阶段启用方式
