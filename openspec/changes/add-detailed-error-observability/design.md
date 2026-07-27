## Context

知萃已经具备管理员审计、用户操作和 LLM Token 观测，但应用异常仍只出现在 uvicorn、systemd 或浏览器控制台中。大量业务路由会将下载器、ASR、Agent 和网络失败转换成 HTTPException，因此仅捕获未处理异常不足；客户端错误也可能只发生在 Web 或 Capacitor 运行时。错误详情必须足以定位问题，同时不能成为请求正文、文案或密钥的旁路存储。

## Goals / Non-Goals

**Goals:**

- 统一保存后端、HTTP、LLM 和已登录客户端错误。
- 提供异常类型、消息、堆栈和安全业务元数据，用于管理端排障。
- 在持久化前执行集中脱敏，并让错误采集失败不影响主流程。
- 在现有“用量与日志”信息架构内增加错误视图。
- 将同一前端代码同步到 Capacitor 并发布新版 APK。

**Non-Goals:**

- 不替代 systemd、Nginx、Jenkins 或第三方 APM 的基础设施日志。
- 不采集请求/响应正文、浏览器录屏、视频、文案、问题或模型答案。
- 不实现错误指派、工单、自动修复或无限期日志保留。
- 不将历史服务器日志导入新表。

## Decisions

### 1. Dedicated append-only error table

新增 `application_error_logs`，使用低敏结构字段，并只提供一个经过脱敏的 message、traceback 和受限 metadata JSON。错误日志与用户操作、管理员审计分表，避免不同语义与保留周期互相污染。

### 2. Central sanitizer before persistence

所有入口必须经过同一个 sanitizer，移除 bearer、常见 secret/API Key/password 赋值、URL 查询参数和过长文本。表结构不含 request_body、headers、prompt、transcript、question 或 response 字段。管理员看到的是脱敏后的持久值，而不是读取时临时遮盖。

### 3. Layered capture

- FastAPI 全局 HTTPException handler 捕获业务转译后的可执行 4xx/5xx；常规 401、403、404 属于控制流，不写入错误表。
- 全局 Exception handler 捕获未处理异常并保存 traceback。
- LiteLLM 包装器在 provider 调用失败时记录 source=`llm` 与受限 operation/provider/model 元数据。
- 客户端 reporter 监听 `error` 与 `unhandledrejection`，只上报 message、stack、pathname 和运行环境，且要求现有 JWT。

相同未处理错误可能同时触发 LLM 和 HTTP 两条记录；它们代表 provider 与请求两个排障层级，保留二者并通过 source 区分。

### 4. Failure-safe independent writes

错误服务使用短生命周期独立 Session，并吞掉自身写入异常，避免 SQLite 锁或数据库故障导致递归错误。客户端上报使用原生 fetch 且在失败时静默结束，防止上报失败形成无限循环。

### 5. Existing observability workspace

在 `AdminObservabilityPanel` 中增加第四个“错误日志”标签。摘要采用可读的数字卡片；详情表在移动端使用自身横向滚动；展开内容使用 `<details>` 或可访问按钮，不引入新动画和新组件库。

## Risks / Trade-offs

- [大量相同错误造成写入增长] → 客户端按短时间指纹去重，服务端限制字段长度；后续可增加保留任务。
- [脱敏遗漏未知 secret 格式] → 从不保存 body/header，额外覆盖常见 bearer、key、password 和 query 模式，并限制 metadata 白名单。
- [错误采集数据库本身不可用] → 写入失败静默，不阻断原请求，基础设施日志仍保留。
- [HTTP 4xx 噪声较多] → 排除常规 401/403/404，校验类 422 仅记录字段位置和错误类型，其他异常可按来源和等级筛选。
- [Capacitor 构建较慢] → 复用现有 Android 工程与 Gradle 缓存，产物完成后再进入 git 提交。

## Migration Plan

1. 导入模型并通过 `Base.metadata.create_all()` 创建新表。
2. 部署错误服务、异常处理器与 API；旧版本数据表不受影响。
3. 部署管理端和客户端 reporter。
4. 生成 production static export、同步 Android、构建并复制 APK。
5. 提交代码和 APK，推送 Gitee，由 Jenkins 重建并重启服务。
6. 回滚时旧代码会忽略新表，表可保留。

## Open Questions

无阻塞问题。自动清理周期和外部告警渠道留待积累实际错误量后确定。
