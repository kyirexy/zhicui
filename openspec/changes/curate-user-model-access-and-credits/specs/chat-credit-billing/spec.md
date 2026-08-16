## ADDED Requirements

### Requirement: 平台聊天请求按模型配置结算萃点
系统 SHALL 在平台模型请求开始前按 Offering 配置预留萃点，成功后结算，完全失败时释放，并使用幂等请求标识避免重复扣费。

#### Scenario: 收费聊天成功
- **WHEN** 用户余额足够并使用收费 Offering 完成一次回答
- **THEN** 系统只追加 reserve 和 capture 账本记录
- **AND** 可用余额按配置的每次萃点减少一次

#### Scenario: 收费聊天失败
- **WHEN** 模型请求未产生可用回答
- **THEN** 系统释放本次全部预留萃点
- **AND** 用户可用余额恢复到请求前状态

#### Scenario: 余额不足
- **WHEN** 用户可用萃点低于 Offering 的每次价格
- **THEN** 系统在调用 Provider 前拒绝请求
- **AND** 返回余额不足与可选择免费模型的提示

### Requirement: 免费模型使用独立每日额度
免费 Offering SHALL 在管理员配置的每日次数内不扣萃点，并 SHALL 按用户、Offering 和 Asia/Shanghai 自然日记录用量。

#### Scenario: 免费额度内请求
- **WHEN** 用户当天免费次数仍有剩余
- **THEN** 系统执行回答并增加一次免费用量
- **AND** 不产生 capture 萃点记录

#### Scenario: 免费额度耗尽
- **WHEN** 用户当天免费次数已经用完
- **THEN** 系统拒绝新的免费请求
- **AND** 不自动切换到任何收费模型

### Requirement: 自定义模型不扣平台模型萃点
用户通过自己的 API Key 发起的聊天请求 MUST NOT 预留或扣除平台模型萃点。

#### Scenario: BYOK 回答成功或失败
- **WHEN** 用户启用并调用自己的兼容模型
- **THEN** 平台萃点余额和聊天免费额度均保持不变
