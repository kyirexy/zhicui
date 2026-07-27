## ADDED Requirements

### Requirement: DeepSeek preset configuration
The system SHALL let an administrator select a supported DeepSeek model and provide an API Key without manually entering the provider endpoint.

#### Scenario: Select DeepSeek Flash
- **WHEN** an administrator saves provider `deepseek` with model `deepseek-v4-flash`
- **THEN** the system persists the model and automatically uses `https://api.deepseek.com`

#### Scenario: Select DeepSeek Pro
- **WHEN** an administrator saves provider `deepseek` with model `deepseek-v4-pro`
- **THEN** the system persists the model and automatically uses `https://api.deepseek.com`

#### Scenario: Reject unsupported preset model
- **WHEN** an administrator submits provider `deepseek` with a model outside the supported preset list
- **THEN** the system rejects the update without changing the active configuration

### Requirement: Existing custom provider compatibility
The system SHALL preserve a custom OpenAI-compatible configuration mode for existing non-DeepSeek models and proxies.

#### Scenario: Save custom provider
- **WHEN** an administrator selects `custom` and provides a model and valid HTTP API base
- **THEN** the system persists and uses those values without applying the DeepSeek endpoint

### Requirement: Secret-safe configuration
The system MUST encrypt newly supplied API Keys at rest and MUST never return the plaintext key to the administrator UI.

#### Scenario: Read active configuration
- **WHEN** an administrator reads the LLM configuration after saving a key
- **THEN** the response includes only a masked key and non-secret provider metadata
