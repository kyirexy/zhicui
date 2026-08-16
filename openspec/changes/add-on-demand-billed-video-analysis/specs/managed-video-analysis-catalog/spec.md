## ADDED Requirements

### Requirement: 管理员维护可测试且不可历史删除的视觉 Provider
系统 SHALL 允许管理员在现有 AI 模型配置页面维护多个视觉 Provider 的驱动、加密凭证、能力、计量、限制、预算和健康状态。被历史任务引用的 Provider 只能停用，不能物理删除。

#### Scenario: 测试图片 Provider
- **WHEN** 管理员测试声明支持图片输入的 Provider
- **THEN** 系统发送内置真实测试图片并记录成功状态与时间
- **AND** API 响应和日志不返回明文密钥或图片 base64

### Requirement: 管理员发布版本化 Offering
系统 SHALL 允许管理员创建解析 Offering 并配置名称、说明、推荐、顺序、方法、Provider、触发渠道、限制、免费额度和价格公式。模型、限制或价格修改 SHALL 产生新版本，已报价任务 SHALL 使用原快照。

#### Scenario: 发布收费 Offering
- **WHEN** 管理员发布价格大于零的 Offering
- **THEN** 系统要求关联 Provider 已通过测试且上游成本已知
- **AND** 为发布内容创建不可变版本

#### Scenario: 发布专业视频 Offering
- **WHEN** `native_video` 没有已安装且通过测试的驱动
- **THEN** 系统拒绝发布并不向用户目录暴露该入口

### Requirement: 免费方案能明确降级
免费 Offering 的用户价格 MUST 为零，并 SHALL 在免费视觉模型不可用时按配置降级为本地场景结构而不是切换到平台收费模型。

#### Scenario: 免费视觉 Provider 熔断
- **WHEN** 免费视觉 Provider 超预算或健康检查失败
- **THEN** 系统以本地基础方式继续或明确拒绝
- **AND** 不产生平台收费视觉调用

### Requirement: 管理端提供风控和运营配置
系统 SHALL 在现有 AI 模型配置、用户抽屉和用量区域提供功能总开关、推荐方案、报价有效期、Agent 候选数、用户上限、并发、Provider 日预算、熔断、重试、萃点调整和成本用量查询，且 MUST NOT 新增管理端主导航。

#### Scenario: 未发布可用 Offering
- **WHEN** 功能关闭或没有管理员测试并发布的 Offering
- **THEN** 用户目录返回功能不可用且界面不显示详细解析入口
