## ADDED Requirements

### Requirement: 详细视频解析只能按需触发
系统 MUST 仅允许用户单条点击、用户批量点击或交互式 Agent 授权流程创建详细解析任务，并 MUST NOT 由同步、转写、普通摘要、AI 初始化、定时自动化、深度研究选项或历史回填自动创建任务。

#### Scenario: 普通同步与摘要
- **WHEN** 用户同步视频并完成字幕提取和普通摘要
- **THEN** 系统不调用场景检测或视觉模型
- **AND** 不创建视频分析 Run 或账务记录

#### Scenario: 用户显式点击
- **WHEN** 用户在可解析视频详情点击详细解析
- **THEN** 系统检查缓存并生成推荐方案或报价

### Requirement: 系统提供本地场景和关键帧视觉路线
系统 SHALL 支持 `local_scene` 与 `scene_frames_vlm`，并 SHALL 仅在已安装适配器时允许发布 `native_video`。PySceneDetect SHALL 作为场景检测和采样层，视觉模型失败时 SHALL 保留可用的本地结构和文稿结果。

#### Scenario: 场景检测成功
- **WHEN** PySceneDetect 从临时视频检测到镜头边界
- **THEN** 系统输出带服务端时间码的章节和场景结构
- **AND** 按 Offering 限制选取关键帧

#### Scenario: 视觉模型失败
- **WHEN** 场景结构成功但图片 VLM 调用失败
- **THEN** 逐项任务标记为 partial
- **AND** 结果保留镜头结构、文稿与明确降级原因

### Requirement: 解析结果可缓存并安全回写
系统 SHALL 按用户、Note、来源指纹和 Offering 版本缓存结构化结果，并 SHALL 将当前结果合并到现有摘要的命名字段而不覆盖未知字段。缓存命中 SHALL 直接复用且不消耗额度或萃点。

#### Scenario: 相同结果缓存命中
- **WHEN** 同一用户请求相同视频、来源指纹和 Offering 版本
- **THEN** 系统直接返回已有分析结果
- **AND** 本次费用和免费额度消耗均为零

### Requirement: 任务和临时媒体具备持久恢复与清理
系统 SHALL 持久化 Run、逐项阶段和结果引用，并 SHALL 在进程重启后重新排队可安全续跑的任务或释放无法续跑任务的预留。系统 MUST NOT 持久化视频、帧、base64、Cookie、签名媒体 URL 或本机临时路径。

#### Scenario: 进程在任务中重启
- **WHEN** 服务启动时发现长期停留在处理中且没有安全续跑点的任务
- **THEN** 系统将该任务失败或重新排队
- **AND** 不让用户萃点永久保持预留

#### Scenario: 任意处理路径结束
- **WHEN** 解析成功、失败、取消或抛出异常
- **THEN** 任务级临时视频和关键帧在 finally 清理
