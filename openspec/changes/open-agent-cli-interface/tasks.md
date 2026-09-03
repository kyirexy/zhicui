## 1. Contract and inventory

- [x] 1.1 Create the OpenSpec proposal, design, new capability specs, and delta specs for the Agent interface.
- [x] 1.2 Add a machine-readable ordinary-user route classification manifest and a test that rejects unclassified or admin-exposed routes.
- [x] 1.3 Define shared v1 Action, Envelope, Run, Event, Error, Scope, Risk, and execution-location contracts.

## 2. Agent credentials and persistence

- [x] 2.1 Add SQLAlchemy models and startup migrations for Agent credentials, device authorization, runs, events, idempotency records, confirmations, and audit entries.
- [x] 2.2 Implement hashed PAT issuance/list/revocation with expiry and scope validation.
- [x] 2.3 Implement browser device authorization create/approve/poll/refresh/revoke with one-time refresh rotation.
- [x] 2.4 Implement shared scope, ownership, per-user/credential/action rate limit, secret redaction, and audit middleware helpers.
- [x] 2.5 Implement short-lived, single-use confirmation records bound to action and normalized input.

## 3. Product Action Registry and API

- [x] 3.1 Implement the explicit ProductActionRegistry and capability filtering without route reflection.
- [x] 3.2 Register safe ordinary-user read Actions for account, library, creator, conversations, knowledge, plans, automations, models, feedback, and run status.
- [x] 3.3 Register ordinary-user write Actions and adapters for link import, creator/manual source sync, multi-video ask, knowledge, plans/tasks, automation, analysis, feedback, export, and account lifecycle, preserving confirmation and billing gates.
- [x] 3.4 Implement persistent Run state transitions, monotonic events, leases, cancellation, one terminal event, and idempotent invocation.
- [x] 3.5 Add `/api/agent-interface/v1` capabilities/action/invoke/run/events/cancel routes with JSON and SSE envelopes.
- [x] 3.6 Add a remote `/mcp` JSON-RPC transport that only publishes cloud ordinary-user Actions from the Registry.
- [x] 3.7 Adapt existing durable Agent Turn and other available long-task records to the v1 Run/event contract without exposing internal research tools.

## 4. TypeScript CLI and MCP

- [x] 4.1 Create the Node 22 ESM `@zhicui/cli` workspace, build scripts, `zhicui` binary, and protocol-safe output/exit-code utilities.
- [x] 4.2 Implement auth device flow, PAT/token storage abstraction, capability discovery, generic Action invoke, run wait/resume/cancel, stdin JSON, and required global flags.
- [x] 4.3 Implement domain command aliases for auth, library, creator, ask, knowledge, plan, automation, analysis, models, feedback, account, local, and run.
- [x] 4.4 Implement `zhicui mcp serve --stdio` with tools generated from capabilities and a restricted local Windows capability adapter.
- [x] 4.5 Implement `zhicui agent setup/doctor/status/update/uninstall` for detected Codex and Claude Code using backups, validation, atomic writes, idempotency, and owned config blocks.
- [x] 4.6 Add CLI tests for clean JSON/JSONL stdout, stderr diagnostics, exit codes, idempotency headers, event ordering, resume, timeout, and local-unavailable errors.

## 5. Web and Windows access center

- [x] 5.1 Add frontend API clients and types for credentials, devices, capabilities, recent calls, and revocation.
- [x] 5.2 Add a responsive Chinese “Agent 接入” settings section with install commands, remote MCP config, least-privilege PAT creation, one-time secret display, connections, scopes, recent calls, and revoke controls; do not add a terminal.
- [x] 5.3 Add Windows-only “连接 Codex / 连接 Claude Code” and local capability diagnosis controls while keeping Android authorization-management only.
- [x] 5.4 Extend Electron contract/preload/main with fixed Agent setup/status/doctor/uninstall IPC and reject arbitrary commands, paths, and secrets from the renderer.
- [x] 5.5 Extract reusable desktop-core identity/lock/result-normalization primitives and apply a cross-process user+platform lock to local collection Actions.
- [x] 5.6 Package the CLI artifacts in the Windows installer and expose the deterministic executable location without exposing Electron internals.

## 6. Verification and release readiness

- [x] 6.1 Add backend tests for Schema, scope denial, cross-user isolation, token expiry/revocation, refresh rotation, rate limits, idempotency conflicts, confirmation replay, event terminal uniqueness, cancellation, and secret redaction.
- [x] 6.2 Add frontend and desktop tests for access-center platform gating, one-time token UI, fixed IPC validation, repeated setup/uninstall, and absence of admin/Shell tools.
- [x] 6.3 Run backend targeted tests, CLI tests/build, frontend tests/build, desktop tests/build, and OpenSpec validation; record any environment-only blockers.
- [x] 6.4 Add beta feature flags, npm/Windows packaging metadata, release notes, and staged rollout documentation without embedding publishing credentials.

## 7. Stable production release

- [ ] 7.1 Enforce an enabled full-rollout configuration and a strong independent Agent token pepper in production deployment and readiness gates.
- [ ] 7.2 Add a destructive-safe live smoke for PAT issue/invoke/run/events/MCP/admin-boundary/revoke with automatic credential cleanup and deployment evidence.
- [ ] 7.3 Promote CLI, Web access-center wording, package metadata, and operator documentation from Beta to Stable and verify a clean release archive.
- [ ] 7.4 Publish `@zhicui/cli@1.0.0` to npm `latest` and verify clean Codex/Claude installation, tool discovery, invocation, repeat setup, uninstall, and config restoration.
- [ ] 7.5 Produce and publish an Authenticode-signed Windows Stable installer (and signed Android Stable artifact when released) and complete install/update/rollback smoke tests.
- [ ] 7.6 Deploy the Web/backend Action layer to production with all reviewed ordinary-user Actions enabled, execute the live Stable smoke and rollback drill, and retain immutable evidence.
