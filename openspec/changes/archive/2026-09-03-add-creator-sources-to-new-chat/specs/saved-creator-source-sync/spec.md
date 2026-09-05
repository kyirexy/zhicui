## ADDED Requirements

### Requirement: 博主列表提供可问答资料标识
系统 SHALL 在列出当前用户保存的博主时，同时返回该博主已导入、未移除、仍可用且具有完整文稿的 Note 标识集合，供用户显式建立 AI 问答资料选择。

#### Scenario: 返回当前用户的已就绪资料
- **WHEN** 已登录用户读取其保存的博主列表
- **THEN** 每个博主响应包含最多 100 个符合问答条件的 `ready_note_ids`
- **AND** 标识只来自同一用户且属于该博主的来源项目

#### Scenario: 过滤不可用资料
- **WHEN** 博主作品未生成文稿、已移除、已标记不可用或关联 Note 不再存在
- **THEN** 该作品的 Note 标识不出现在 `ready_note_ids` 中
