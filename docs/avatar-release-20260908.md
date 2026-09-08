# 卡通头像发行

- 使用内置 imagegen 独立生成 12 张卡通人像，提示词见 avatar-prompts-20260908.json。
- 发布资源：frontend/public/images/avatars/v1/portrait-01.webp 至 portrait-12.webp；每张 256×256，整套约 82 KB。
- 设置的通用页提供头像选择；桌面侧栏、网页账号入口和设置账号信息使用统一组件。
- users.avatar_id 为可空预设标识；未选择时按用户 ID 稳定选取默认人像，不批量改写旧账号。
- PATCH /api/auth/avatar 需要当前用户认证，仅允许 portrait-01 至 portrait-12，不接受外部图片 URL。
- 当前设备保存成功后即时更新；其他设备回到前台或重新登录时读取账号头像。
- 数据库迁移为新增可空列，兼容旧客户端；Android 内置前端需要更新安装包。
- 同步补齐已存在的 GET /api/admin/business-overview 路由清单；仍属于管理员边界。
