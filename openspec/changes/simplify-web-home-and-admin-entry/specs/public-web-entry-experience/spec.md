## ADDED Requirements

### Requirement: Public homepage communicates only the core product path
公开 Web 首页 SHALL 以 Hero、三个核心功能和客户端下载中心作为主要内容区，并 SHALL NOT 重复展示长篇品牌陈述、流程教学、问答案例或重复下载 CTA。

#### Scenario: New visitor scans the homepage
- **WHEN** 新访客打开公开 Web 首页并向下浏览
- **THEN** 访客依次看到产品核心主张、三个核心功能和 Android/Windows 下载中心

### Requirement: Core functions are concise and outcome-oriented
首页 SHALL 用“批量整理视频”“基于资料提问”“保存知识或计划”三个功能项说明产品，每项 MUST 只包含语义图标、短标题和一句结果说明。

#### Scenario: Visitor reads the core functions
- **WHEN** 访客查看核心功能区
- **THEN** 访客无需阅读流程教程即可理解产品能整理资料、回答问题并沉淀行动

### Requirement: Public homepage does not imply ordinary login is required
匿名访问公开首页 SHALL 无需登录，营销顶部 MUST NOT 向匿名或普通用户显示普通账号登录按钮或“账号已登录”状态。

#### Scenario: Anonymous visitor opens the homepage
- **WHEN** 未登录访客打开 `/`
- **THEN** 页面直接展示产品与客户端下载，不显示普通账号登录要求

#### Scenario: Ordinary signed-in user opens the homepage
- **WHEN** 已登录但非管理员用户打开 `/`
- **THEN** 营销顶部不显示账号状态或管理员入口

### Requirement: Administrator entry remains discoverable and protected
营销页脚 SHALL 提供“管理员入口”并访问 `/admin`；匿名管理员 MUST 通过登录页认证，后台 MUST 在展示数据前校验管理员权限。

#### Scenario: Anonymous visitor selects administrator entry
- **WHEN** 未登录访客点击页脚“管理员入口”
- **THEN** 系统进入 `/login?redirect=/admin` 登录流程且不展示后台数据

#### Scenario: Administrator completes login
- **WHEN** 具有管理员权限的用户从管理员登录流程成功登录
- **THEN** 系统返回 `/admin` 并展示管理员工作台

#### Scenario: Non-admin user reaches administrator route
- **WHEN** 已登录但没有管理员权限的用户访问 `/admin`
- **THEN** 系统拒绝展示后台并返回公开首页

### Requirement: Signed-in administrators retain a direct shortcut
营销顶部 SHALL 仅在当前用户已经具有管理员权限时显示“管理端”快捷入口。

#### Scenario: Signed-in administrator opens homepage
- **WHEN** 已登录管理员打开公开首页
- **THEN** 顶部显示可直接进入 `/admin` 的“管理端”入口
