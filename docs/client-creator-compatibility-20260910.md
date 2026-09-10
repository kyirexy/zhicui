# 抖音博主功能：Android 与 Windows 兼容验收（2026-09-10）

## 结论与版本范围

本次抖音博主连接器、分页、合作作品身份及文稿任务修复发生在服务端。当前生产安装包已包含所需页面与 API 调用契约，不需要为了这些服务端修复重复打包。

| 客户端 | 线上安装包 | 包内源码提交 | 核验结果 |
| --- | --- | --- | --- |
| Android | 1.3.7，build 29，Beta | `60d680a23c98c92c6e86742452af62ddab4ab87a` | 与本次发行源码的 `frontend/src`、Android、Capacitor 配置及依赖锁完全一致 |
| Windows | 1.1.4，Beta | `998f1390f495337f6723dffad6bf32e0ba655558` | 与本次发行源码的 `desktop` 完全一致；安装版默认加载 `https://luxai.cn` |

比较基线为博主功能生产提交 `deb4bf721296aea465d6d7d8b3f0e2f3dab9199b`，本轮后续仅修改服务端、运维资产与测试时结论保持成立。实际比较也包含工作树中的未提交源码差异，两个上述功能目录均为空差异。

Android 的 `webDir` 为 `out`，页面随 APK 打包，API 使用生产域名；不能笼统承诺 Android 所有未来页面更新都无需升级 APK。本次恰好页面源码已一致，故可直接使用新增服务端能力。

## 实际刷新方式

- Windows：退出并重新打开「博主作品」，或重启客户端。页面从生产站点加载；博主列表接口重新返回平台启用状态。
- Android：使用已发布的 1.3.7（29），退出再进入「博主作品」，或重启应用。页面初始化会重新请求博主列表、平台能力与任务状态。
- 两端能力按钮取自接口返回的 `catalog.enabled`、`catalog.platforms.douyin` 和目录操作能力，没有将「抖音未测试」固定编译为禁用状态。
- 同步及文稿任务仍由用户手动启动；刷新页面不会自动批量提交提取任务。

## 已完成验证

1. 四份线上 Android/Windows Beta、Stable JSON 清单完整回读，并与发行源清单逐字段比较一致。
2. Windows `beta.yml`（348 字节）及版本化 blockmap（99,200 字节）完整公网回读，SHA-256 均与已发布清单一致。
3. 本地已发布 APK、Windows 隔离发行缓存安装包的完整字节大小和 SHA-256 匹配线上清单；公网 HEAD 为 200，Content-Length 一致。本轮没有再次下载两份完整安装包。
4. `node scripts/verify-release-manifests.mjs --platform=android` 通过：包含 Android APK 校验及四份渠道清单结构检查。
5. 从发行工作树编译 Windows 源码通过；`verify-release-contract.mjs` 与 `verify-update-policy.mjs` 通过，包括渠道隔离、快捷方式、开发版不更新、并发检查复用及下载中不重启下载。
6. `test_release_reproducibility` 13 项通过；`test_client_download_analytics` 5 项通过。
7. 现有 `verify-public-release-browser.mjs` 对 `https://luxai.cn` 的真实 Chrome/Edge 浏览器验证通过：320/390px，首页、下载、条款、隐私、支持、平台限制共 6 条公开路由。该测试没有登录用户或提交业务数据；不能替代真实 Android 安装/升级验收。

安装包身份：

| 安装包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Android 1.3.7（29） | 34,416,262 | `6f60497581a47882df61fda113a623e4b53badf06e83b5562bdc561d2d6e85d4` |
| Windows 1.1.4 | 93,668,792 | `f232a963e2468f180c53fbcb52596567ba3c11d4e92a93b8a86175d68ce5e0ed` |

本机公网验收记录：`D:/6month/.codex-artifacts/client-creator-compatibility-20260910/public-artifacts.json`。记录不含用户凭据或业务文稿。

## 本轮发现并修复的更新清单缓存问题

2026-09-10 09:27 UTC 公网完整回读发现，Windows 可变 `beta.yml` 返回 `Cache-Control: public, max-age=31536000, immutable`。原因是 Nginx 原来的 feed 正则 location 被同级 `/download/windows/` 的 `^~` 前缀优先级绕过。

`deploy/nginx-windows-updates.conf` 已将 `latest.yml`、`beta.yml`、`stable.yml` 改为精确 location，确保三条可变地址返回 `no-store, no-cache, must-revalidate`，并保留版本化安装包和 blockmap 的长期不可变缓存。回归测试逐渠道确认精确规则、持久文件映射和缓存头，同时确认版本化目录仍可长期缓存。

当前 electron-updater 默认会给检查请求追加防缓存查询参数，能缓解影响；服务端仍需提供正确缓存语义，不能依赖所有读取方都追加参数。

该配置属于预安装运维资产：提交并部署源码后，仍需由生产运维流程安装到 `/etc/nginx/snippets/zhicui-windows-updates.conf`、执行 `nginx -t`、reload，然后公网回读三个 feed 的状态与缓存头。本报告写入时源码与回归已完成，生产配置切换及最终回读由主任务记录。

## 渠道边界

当前两个安装包均通过既有 Beta 下载渠道提供，连接 `https://luxai.cn` 正式服务。两个 Stable 清单明确为 unavailable；本轮没有把 Android Debug 包或未签名 Windows 包改称 Stable，也没有伪造签名或真机验收证据。新功能部署到正式服务与安装包晋升 Stable 渠道是不同操作。
