## 1. Unified theme state

- [x] 1.1 Add a global light/dark/system preference to the shared settings state with legacy preference migration
- [x] 1.2 Apply the effective theme before hydration and respond to operating-system theme changes
- [x] 1.3 Replace the binary header toggle and complex appearance controls with accessible three-choice selectors
- [x] 1.4 Update light, dark, PWA, and Android launch surfaces so the first-use experience is white with restrained mint

## 2. Agent interface

- [x] 2.1 Create and adopt a reusable non-anthropomorphic Agent brand mark
- [x] 2.2 Refine the Agent workspace hierarchy, empty state, messages, evidence, stages, and composer
- [x] 2.3 Verify compact panels, 44px touch targets, safe-area composer behavior, and no overflow at 390px

## 3. Agent orchestration

- [x] 3.1 Express question planning, transcript scan, evidence ranking, optional web search, synthesis, and verification as explicit service stages
- [x] 3.2 Verify transcript and web citations against the retrieved candidate set and downgrade unsupported grounding claims
- [x] 3.3 Return concise public trace metadata and limitations without exposing hidden reasoning
- [x] 3.4 Add or update backend tests for structured parsing, invalid citations, web fallback, and full-snapshot scan behavior

## 4. Verification and client sync

- [x] 4.1 Run focused backend tests and production frontend build
- [x] 4.2 Verify the Agent and settings routes in light, dark, system, desktop, and 390px mobile states
- [x] 4.3 Sync the verified web build into the Android client resources without publishing or deploying
