## ADDED Requirements

### Requirement: 正式与内测客户端渠道隔离
系统 SHALL 使用独立的 `stable` 与 `beta` 发行清单；未签名 Windows 包、Android Debug 包或身份验证失败的产物 MUST NOT 进入 stable 清单。

#### Scenario: 未签名 Windows 包申请正式发布
- **WHEN** 发布验证发现 Authenticode 缺失或签名不受允许身份信任
- **THEN** stable 发布失败且当前正式清单保持不变

#### Scenario: Debug APK 申请正式发布
- **WHEN** APK 可调试或证书指纹不是配置的 release 身份
- **THEN** stable 发布失败且产物最多只能进入明确标记的 beta 渠道

### Requirement: 客户端发行物身份和完整性可验证
发布流程 MUST 验证版本、构建号、文件大小、哈希、签名身份、安装包元数据与更新清单一致，并 SHALL 最后原子切换公开清单。

#### Scenario: 发行物一致
- **WHEN** 所有身份和完整性检查通过
- **THEN** 系统允许上传版本化文件并原子更新对应渠道清单

### Requirement: 签名凭据不得进入代码仓库
Windows 证书、Android keystore 和密码 MUST 仅通过受限本机或 CI secret 注入，日志和公开清单 MUST NOT 暴露私钥或密码。

#### Scenario: 缺少签名凭据
- **WHEN** stable 构建环境未提供所需凭据
- **THEN** 构建在签名前失败并给出配置名称，不输出秘密值
