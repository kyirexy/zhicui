## Why

Video-grounded answers currently stop when a requested fact or link is absent from the transcript, even when the user explicitly asks the agent to look it up. Batch transcript generation also runs too sequentially, so processing 20–50 selected videos takes much longer than the independent work requires.

## What Changes

- Add an opt-in web research tool to the video and library Q&A agent so it can search for missing current information, verify likely matches, and return clickable sources without presenting web findings as transcript facts.
- Improve agent planning so it decides when transcript retrieval is sufficient and when external research is necessary, including follow-up questions such as finding the GitHub repository mentioned in a video.
- Redesign the Q&A result and composer components to make answer scope, research status, citations, follow-up prompts, and agent progress easier to scan on desktop and mobile.
- Replace sequential post-sync extraction with a concurrent batch orchestrator that starts all selected items promptly, separates download/ASR/LLM concurrency limits, reports per-item progress, retries transient failures, and never persists video binaries in the application database.
- Add administrator-configurable concurrency and web-search settings with safe defaults and operational visibility.

## Capabilities

### New Capabilities

- `grounded-web-research`: Agent planning, opt-in web lookup, source verification, citations, provenance separation, and research-oriented Q&A UI.
- `parallel-library-extraction`: Concurrent transcript/card generation, per-stage limits, per-item progress, retries, partial success, and metadata-only persistence.

### Modified Capabilities

<!-- No existing main-spec requirements are changed; these capabilities extend the current library and Q&A behavior. -->

## Impact

- Backend agent services, runtime settings, Q&A request/response types, library extraction orchestration, activity/error observability, and FastAPI routes.
- Frontend video knowledge workspace, library batch controls/progress, API types, responsive component styling, and administrator settings.
- Production may require a web-search provider credential; DeepSeek remains the reasoning model and uses the search integration as an external tool because the standard DeepSeek chat API does not itself guarantee live web access.
- No video binary is stored in PostgreSQL; temporary media remains lifecycle-bound to an extraction task and is removed after transcription.
