## 1. Runtime model configuration

- [x] 1.1 Add DeepSeek provider constants, legacy inference, model validation and LiteLLM routing helpers
- [x] 1.2 Extend administrator LLM config APIs with provider metadata and server-enforced DeepSeek presets
- [x] 1.3 Route the administrator connection test through the shared runtime model and usage helpers

## 2. Observability data and services

- [x] 2.1 Add indexed LLM usage and user activity SQLAlchemy models and register them at startup
- [x] 2.2 Add request context and failure-safe LLM usage recording, aggregation and serialization services
- [x] 2.3 Add safe normalized user activity recording, filtering and aggregation service
- [x] 2.4 Add request middleware plus explicit login, registration and development-session activity events
- [x] 2.5 Add administrator-only Token usage and user activity APIs
- [x] 2.6 Instrument all active LLM completion paths without storing prompts or generated content

## 3. Administrator UI

- [x] 3.1 Extend frontend API types and clients for providers, Token usage and user activity
- [x] 3.2 Replace free-form LLM fields with a DeepSeek preset-first configuration workspace
- [x] 3.3 Add a unified Token usage, user operation and administrator audit workspace
- [x] 3.4 Verify responsive information density, loading, empty, error and pagination states

## 4. Verification

- [x] 4.1 Verify OpenSpec artifacts and backend imports/table creation
- [x] 4.2 Verify provider validation, usage aggregation and sensitive-field exclusion
- [x] 4.3 Run the Next.js production build and backend compile checks
- [x] 4.4 Inspect the local administrator UI and confirm existing audit/config behavior remains available
