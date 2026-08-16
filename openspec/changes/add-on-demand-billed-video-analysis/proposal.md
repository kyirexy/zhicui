## Why

知萃当前的视频处理主要依赖字幕与文稿，无法可靠回答画面演示、可见文字、人物动作和关键事件等问题；但完整视觉解析又具有明显的模型与算力成本，不适合作为同步或普通摘要的默认步骤。需要新增一套用户显式触发、可报价、可结算、可恢复且能被 Agent 安全调用的详细视频解析能力。

## What Changes

- 新增按需详细视频解析：以 PySceneDetect 做本地场景检测与关键帧采样，可选图片 VLM，并预留原生视频模型适配器接口。
- 新增持久化解析任务、逐视频状态、结构化视觉结果、缓存复用及摘要回写；普通同步、转写、摘要、自动化与历史数据均不得自动触发。
- 新增视觉 Provider 与用户可选 Offering 目录，支持免费、本平台付费和独立视觉 BYOK，并由管理员在现有 AI 模型配置区域发布和管控。
- 新增统一“萃点”账户、只追加账本、报价快照、原子预留、按实际用量结算、释放、退款与重启恢复机制；`1000 萃点 = ¥1`。
- 在现有视频详情、资料库批量操作、后台任务入口和用量页面内加入渐进式交互，不增加内容 Tab 或管理端主导航。
- 为交互式 Agent 新增受控 `analyze_video_details` 工具及审批/恢复协议；缓存可直接使用，免费单条可自动执行，批量、付费和 BYOK 必须显式授权。
- 新增安全边界：不持久化临时视频、关键帧、base64、Cookie 或签名媒体地址，BYOK 失败不回退平台收费凭证，客户端不能决定价格。

## Capabilities

### New Capabilities

- `on-demand-video-analysis`: 按需场景检测、关键帧视觉理解、持久任务、结果缓存、摘要回写和后台恢复。
- `analysis-credit-billing`: 萃点账户、免费额度、服务端报价、预留、实际结算、释放、退款和成本核算。
- `managed-video-analysis-catalog`: 管理端视觉 Provider、解析 Offering、版本发布、推荐策略、预算、并发和熔断配置。
- `agent-video-analysis-tool`: Agent 对视觉解析的受控选源、审批、运行状态、恢复回答和视觉证据协议。

### Modified Capabilities

- `multi-platform-video-library-import`: 明确哪些跨平台资料可手动详细解析，并确保导入、字幕提取与普通摘要不会触发视觉解析。
- `knowledge-library-workspace`: 在现有详情和批量工作区加入次级解析入口、后台进度与结果状态，且不增加永久 Tab。

## Impact

- 后端新增 SQLAlchemy 模型、启动迁移、视频分析路由与服务、持久后台执行器、PySceneDetect/OpenCV 依赖，以及 Agent 工具审批协议。
- 前端扩展视频详情、资料库批量菜单、AppHeader 全局任务 Sheet、Agent 消息和现有管理端 AI 配置/用户/用量区域。
- API 新增 `/api/video-analysis/*`、用户视觉 BYOK 与管理端 Provider/Offering/账务接口；现有同步和普通 AI 接口保持兼容。
- 生产环境需安装 `scenedetect-core` 与无界面 OpenCV，并在管理员测试且发布 Offering 前保持功能总开关关闭。
