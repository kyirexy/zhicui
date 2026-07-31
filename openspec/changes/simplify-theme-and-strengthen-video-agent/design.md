## Context

The product currently has three partially overlapping appearance systems: root CSS variables whose no-attribute default is dark, a binary header toggle, and desktop-only sidebar appearance settings. The Agent workspace also mixes older emerald/glass styles with newer blue refinements and generic robot icons. On the backend, the Agent already retrieves transcript evidence and stores traces, but planning, retrieval, optional web work, synthesis, and verification are not expressed as a single stable contract.

The change must work in a client-rendered Next.js application, a Capacitor Android export, and an Electron desktop shell. Existing user data and Agent conversations must remain readable. Video files must remain outside the database and server storage.

## Goals / Non-Goals

**Goals:**

- Make light the deterministic first-use theme and provide only system, light, and dark choices.
- Use white/neutral surfaces and a small amount of mint as the default visual language.
- Give the Agent a reusable, non-anthropomorphic identity and clearer desktop/mobile interaction hierarchy.
- Make the server-side Agent pipeline explicit, bounded, observable, and citation-verified.
- Preserve graceful fallback behavior for malformed model output and optional web-search failure.

**Non-Goals:**

- Building a Codex-style theme marketplace or per-token color editor.
- Replacing the current frontend stack or adding a new agent framework solely for branding.
- Exposing model chain-of-thought.
- Storing, duplicating, or uploading source video files.
- Deploying production or publishing a new APK as part of this change.

## Decisions

### 1. One global preference with a resolved effective theme

Store `theme` as `light`, `dark`, or `system`. A small shared client utility resolves `system` through `prefers-color-scheme`, sets `data-theme` to the effective value, and keeps `data-theme-preference` for controls. The root layout inline script uses the same logic before hydration to avoid a flash or blank shell.

Alternative considered: keep separate desktop sidebar colors. Rejected because it produces conflicting settings and prevents the desktop shell from feeling coherent.

### 2. Light-first semantic tokens, not page-specific repainting

The light palette becomes the primary token set: white/warm-neutral surfaces, dark neutral text, and one muted mint accent. Dark remains a complete alternative through the existing `data-theme="dark"` selector. Components consume semantic variables rather than new hard-coded accent colors.

Alternative considered: append another large Agent-only override block. Rejected because accumulated overrides caused regressions and inconsistent themes.

### 3. Reusable abstract Agent mark

Create a small inline SVG React component built from a leaf/knowledge path and a verification point. It carries no face, antenna, or mascot motion and can be rendered at icon and empty-state sizes. The component is used everywhere the assistant identity appears.

Alternative considered: install an icon or avatar library. Rejected because the project already has icon primitives and a custom mark is smaller and more distinctive.

### 4. Existing Agent service remains the orchestration owner

Strengthen the current service rather than introduce LangChain or LangGraph. The service creates a compact query plan, scans all frozen transcripts server-side, globally ranks evidence, optionally searches the web, synthesizes against an explicit response contract, then verifies returned citations against the candidate evidence map.

Alternative considered: migrate to a third-party graph framework. Rejected because the current flow is bounded and linear; a framework migration would add persistence and deployment risk without improving user-visible capability.

### 5. Trace is operational metadata, not reasoning

Each completed stage records a public label, status, counts, duration, and a short result summary. Prompts, hidden reasoning, secrets, and raw chain-of-thought are never returned. The UI renders these records only after or while the corresponding work genuinely occurs.

### 6. Verification fails closed for grounding claims

Evidence IDs and quotations returned by the model are reconciled with the actual retrieved transcript/web candidates. Unknown IDs are discarded. A response is marked grounded only when at least one verified source supports it; limitations remain visible when coverage is partial.

## Risks / Trade-offs

- [Theme migration can surprise users with a legacy sidebar choice] → Migrate only when no explicit global theme exists and leave density untouched.
- [System-theme listeners can duplicate during client remounts] → Centralize listener registration and always return cleanup functions.
- [Full transcript scanning can increase latency for 100 videos] → Keep scanning local/server-side, bound per-document chunks and final synthesis context, and expose truthful counts.
- [Strict citation verification can remove model-written evidence] → Preserve the answer but downgrade grounding and show a concise limitation instead of failing the turn.
- [Existing CSS specificity may override new tokens] → Replace the current Agent refinement rules in place and verify computed styles at desktop and 390px widths.

## Migration Plan

1. Add the global theme resolver and update pre-hydration initialization.
2. Replace settings and header controls while retaining legacy preference migration.
3. Introduce the Agent mark and refactor current Agent component styles in place.
4. Extend the existing Agent service and response types with verified trace metadata.
5. Build the frontend, run backend tests, verify desktop/mobile routes, then sync Android web assets.
6. Roll back by reverting the frontend preference resolver and Agent service changes; no database downgrade is required.

## Open Questions

- Whether production should later sync theme preferences across devices is intentionally deferred; this change keeps device-local persistence.
- Streaming per-stage Agent events may be added later. This change makes the trace contract ready without pretending synchronous stages are live.
