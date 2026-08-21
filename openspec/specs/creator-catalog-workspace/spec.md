# creator-catalog-workspace Specification

## Purpose
TBD - created by archiving change add-full-creator-catalog-selection. Update Purpose after archive.
## Requirements
### Requirement: 用户可以在独立博主页面管理来源
系统 SHALL 提供 `/library/creators` 页面用于粘贴官方主页、保存来源、启动近期文稿或全量目录刷新以及移除来源，并 MUST 让该页面继续归属于现有“视频”导航目的地。

#### Scenario: 打开博主页面
- **WHEN** 用户从视频资料库进入 `/library/creators`
- **THEN** 系统显示当前用户保存的博主和可用操作
- **AND** 移动端底部导航仍选中“视频”且不新增第六个入口

#### Scenario: 跨路由继续运行
- **WHEN** 用户启动任务后关闭页面、刷新或切换路由
- **THEN** 全局任务状态继续轮询并恢复同一持久运行
- **AND** 页面组件不启动第二个长轮询器

### Requirement: 全量目录可分页搜索和筛选
系统 SHALL 将博主当前可读取的全部公开视频按发布时间倒序展示，默认每页 50 条，并 SHALL 支持搜索及未转写、已入库、失败状态筛选。

#### Scenario: 浏览千条目录
- **WHEN** 一个博主目录包含超过一千条作品
- **THEN** API 和页面仅返回请求页及稳定分页游标
- **AND** 排序相同的项目使用稳定 ID 打破并列

#### Scenario: 刷新发现总数未知
- **WHEN** 全量刷新尚未完成发现
- **THEN** 页面显示不定进度和当前已发现数量
- **AND** 完成发现后改为准确总数和确定进度

### Requirement: 用户每次最多选择五十条准备文稿
系统 SHALL 允许用户从目录中选择 1 至 50 条可用作品准备普通文稿，MUST 拒绝空选择、超过 50 条或不属于当前用户来源的项目。

#### Scenario: 提交有效选择
- **WHEN** 用户勾选不超过 50 条未转写作品并确认
- **THEN** 系统创建持久的 `selected_transcript` 任务
- **AND** 成功项目进入现有视频资料库，纯元数据项目仍只留在博主页面

#### Scenario: 选择超过上限
- **WHEN** 用户试图勾选或提交第 51 条作品
- **THEN** 页面阻止选择且 API 拒绝伪造的超限请求
- **AND** 不创建部分任务

### Requirement: 任务详情支持取消、失败解释和重试
系统 SHALL 展示来源快照、操作、阶段、发现与处理计数、聚合结果和需用户处理原因，并 SHALL 提供取消以及失败项目重试。

#### Scenario: 取消运行
- **WHEN** 用户请求取消活动目录或文稿任务
- **THEN** 系统停止继续发现或处理并保留已完成项目
- **AND** 取消按钮进入不可重复提交的“正在停止”状态

#### Scenario: 用户处理认证问题后重试
- **WHEN** 任务因登录失效、验证码或风控标记 `needs_action`
- **THEN** 页面显示脱敏、可操作的原因
- **AND** 用户完成外部处理后可显式重试未完成项目

### Requirement: 博主交互遵守 React DOM ownership
系统 MUST 使用稳定挂载的原生 `<dialog>` 或等价的 React 所有权安全结构承载确认和任务详情，MUST NOT 手工移动或删除 React 渲染节点。

#### Scenario: 快速反复开关对话框
- **WHEN** 用户快速开关、切换路由或开发环境热更新
- **THEN** 对话框状态保持一致且后台任务不受影响
- **AND** 不出现 `removeChild`、Portal 宿主或重复挂载错误
