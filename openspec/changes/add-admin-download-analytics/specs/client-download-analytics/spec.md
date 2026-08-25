## ADDED Requirements

### Requirement: 客户端下载请求可被聚合统计
系统 SHALL 为 Android 和 Windows 客户端提供可计数下载入口，并 SHALL 在请求下载时按平台和自然日增加一次聚合计数。

#### Scenario: 用户下载 Android 客户端
- **WHEN** 用户访问 Android 可计数下载入口
- **THEN** 系统将当天 Android 下载计数增加一次
- **AND** 系统重定向到既有 APK 静态文件

#### Scenario: 用户下载 Windows 客户端
- **WHEN** 用户访问 Windows 可计数下载入口
- **THEN** 系统将当天 Windows 下载计数增加一次
- **AND** 系统重定向到既有 Windows 安装包静态文件

#### Scenario: 计数存储暂时不可用
- **WHEN** 下载计数写入失败
- **THEN** 系统仍允许用户进入白名单中的安装包下载地址
- **AND** 系统记录服务端错误供运维诊断

### Requirement: 下载统计保护访问者隐私
系统 MUST 仅保存日期、平台和聚合次数，并 MUST NOT 保存下载者 IP、User-Agent、Cookie、用户身份或设备标识。

#### Scenario: 下载计数被持久化
- **WHEN** 系统记录一次下载请求
- **THEN** 持久化数据仅改变对应日期和平台的聚合计数

### Requirement: 管理员可查看下载量
系统 SHALL 在管理端展示累计下载次数、今日下载次数、近 7 日下载次数、平台拆分和近期逐日趋势，并 SHALL 仅允许管理员访问这些统计。

#### Scenario: 管理员打开概览
- **WHEN** 管理员访问管理端统计概览
- **THEN** 页面展示下载总量、今日和近 7 日指标
- **AND** 页面分别展示 Android 与 Windows 下载量
- **AND** 页面展示最近 14 个自然日的趋势

#### Scenario: 普通用户请求下载统计
- **WHEN** 非管理员请求管理端统计接口
- **THEN** 系统拒绝访问且不返回下载统计

### Requirement: 官方下载入口统一经过统计
系统 SHALL 让官网、应用内下载按钮和二维码使用可计数下载入口，同时 SHALL 保持旧静态文件可用以兼容既有链接。

#### Scenario: 用户从官方界面发起下载
- **WHEN** 用户点击官方 Android 或 Windows 下载入口或扫描官方二维码
- **THEN** 请求首先到达对应平台的可计数下载入口
