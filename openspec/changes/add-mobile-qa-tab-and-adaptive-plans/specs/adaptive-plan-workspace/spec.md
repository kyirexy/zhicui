## ADDED Requirements

### Requirement: AI controls plan structure
计划生成器 MUST 根据视频文案自主决定动态字段数量、字段分组、执行日和任务数量，并 MUST NOT 强制固定的最少字段数或连续每日模板。

#### Scenario: Video describes sparse milestones
- **WHEN** 视频只描述第 1、3、7 天的关键行动
- **THEN** AI 计划可以只生成这些执行节点而不补造第 2、4、5、6 天任务

#### Scenario: Video contains few meaningful metadata fields
- **WHEN** 视频只提供目标和完成标准两类可靠计划信息
- **THEN** AI 计划只保存这两个动态字段而不为满足数量要求虚构其他字段

#### Scenario: Video contains rich planning information
- **WHEN** 视频明确提供频率、次数、资源、阶段、风险和衡量标准
- **THEN** AI 可生成对应数量和分组的动态字段并由工作台完整展示

### Requirement: Fine-grained task schedule
计划任务 MUST 支持可选的日期时间、预计时长、执行频率和 AI 自定义细节，同时 MUST 兼容只有日期或只有所属计划日的旧任务。

#### Scenario: AI extracts exact execution time
- **WHEN** 视频明确说明某天某个时间执行任务
- **THEN** 任务保存到分钟的 `scheduled_at` 并在执行清单显示日期与时间

#### Scenario: AI extracts repetitions and duration
- **WHEN** 视频说明任务要执行若干次或持续一定分钟
- **THEN** 任务以 `frequency`、`duration_minutes` 或自定义细节字段保存并靠近任务标题展示

#### Scenario: Old task has date only
- **WHEN** 工作台读取 `scheduled_at` 为 `YYYY-MM-DD` 的旧任务
- **THEN** 今日、逾期、排序、编辑和展示行为继续正常

### Requirement: User can refine fine-grained task metadata
任务编辑器 SHALL 允许用户修改任务日期时间、预计时长和执行频率，并 SHALL 将空值解释为移除对应可选属性。

#### Scenario: User schedules a task to the minute
- **WHEN** 用户在任务编辑器选择日期与时间并保存
- **THEN** API 接受并返回到分钟的 ISO 本地日期时间且计划的 flat tasks 与 days 同步

#### Scenario: User clears optional metadata
- **WHEN** 用户清空日期时间、时长或频率并保存
- **THEN** 系统从任务 JSON 中移除对应属性且保留其他 AI 细节

### Requirement: Dynamic fields are safely rendered
计划工作台 MUST 按 AI 提供的字段分组显示动态字段，并 MUST 对未知但合法的字段类型进行安全文本降级。

#### Scenario: AI groups plan fields
- **WHEN** 动态字段包含目标、节奏、资源等不同 `group`
- **THEN** 工作台按分组标题组织字段且保持 AI 决定的字段数量

#### Scenario: AI returns an unknown field type
- **WHEN** 字段结构合法但 `type` 不在前端预置类型中
- **THEN** 工作台将其值作为不可执行的文本或键值内容展示而不报错
