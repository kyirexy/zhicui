## 1. Agent reliability

- [x] 1.1 Add one-shot empty-content recovery to the shared LLM call path
- [x] 1.2 Record the original Agent exception with safe provider and operation metadata
- [x] 1.3 Add regression coverage for empty-content recovery and failure logging

## 2. Personal knowledge data

- [x] 2.1 Add the user-owned knowledge entry model and startup migration/import wiring
- [x] 2.2 Add scoped CRUD and unified knowledge list/search API endpoints
- [x] 2.3 Add backend tests for knowledge ownership, validation, and mixed search

## 3. User AI provider

- [x] 3.1 Add encrypted per-user provider configuration and runtime resolution
- [x] 3.2 Add masked read, save, reset, policy, and connection-test endpoints
- [x] 3.3 Route video Agent calls through the owning user's effective provider

## 4. Knowledge and settings interfaces

- [x] 4.1 Replace card-type filters and grid mode with a unified permanent knowledge stream
- [x] 4.2 Add create, edit, view, and delete interactions for original knowledge
- [x] 4.3 Add user AI service configuration to Settings with platform-default and custom modes
- [x] 4.4 Verify desktop and mobile loading, empty, error, dark-mode, focus, and safe-area states

## 5. Verification

- [x] 5.1 Run targeted backend tests and TypeScript checks
- [x] 5.2 Run the Next.js production build and strict OpenSpec validation
