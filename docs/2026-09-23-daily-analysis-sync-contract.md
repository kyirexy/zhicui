# 今日分析同步批次修复

## 问题与修复

- 今日分析发送的 `daily-analysis:<userId>:<UUID>` 包含冒号，违反桌面端批次编号校验；B站又误用了只支持抖音的批次字段，导致四个来源均在采集前失败。
- 抖音收藏、喜欢分别使用纯 UUID；B站不发送 `sessionKey` 或 `keepSessionOpen`。保留客户端现有安全校验，无需更新安装包。
- 取消仅使用本轮抖音批次，不调用全局取消；取消或切换账号后，旧采集结果不能保存，也不能启动下个来源。
- 同步错误清除 Electron 通信包装，保留中文登录、验证等操作提示；英文技术异常显示简洁中文兜底。一项来源失败时继续处理其他来源。

## 验证

- 回归测试直接加载 `desktop/src/security.ts` 的实际请求与取消校验器，验证旧请求被拒绝、四来源新请求通过，并验证字段缺失、批次隔离、取消、切号和部分失败。
- `npm run test:home-sync`：85 项通过，已将此次回归加入该常规检查入口。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `npm run build`：正式构建通过。
- 正式发布通过 Gitee/Jenkins 既有构建、加密备份、隔离恢复、readiness 和真实用户旅程闸门；发布结果留存 Jenkins 日志与服务器 `/var/lib/zhicui-deployments`，外部通过 `/build-version.json`、`/api/health` 核验。

## 验证边界

本机通过真实桌面参数校验器与模拟采集结果验证完整同步调度及回顾流程；未替用户在其已登录的抖音/B站窗口发起实际采集。
