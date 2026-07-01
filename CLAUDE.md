# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project identity

VideoCapsule — turn long Douyin videos into structured knowledge cards. Paste a video URL, the app extracts the transcript (ASR), AI generates a formatted card (sections + conclusion + pitfall rating), and the result is saved as a shareable note. The UI is Chinese-first, mobile-first, dark-glassmorphism.

## Commands

```bash
# Backend (Python 3.12, pip)
cd backend
pip install -r requirements.txt
python run.py                    # starts uvicorn on :8000 with reload

# Frontend (Next.js 16, npm)
cd frontend
npm install
npm run dev                      # Next.js dev server on :3000
npm run build                    # production build
npm run cap:build                # static export + Capacitor Android sync (sets NEXT_PUBLIC_API_URL for emulator)

# All-in-one startup
./start.sh                       # macOS/Linux — installs deps, starts backend then frontend
start.bat                        # Windows equivalent
```

No test runner or linter is configured yet. There are no `test` or `lint` scripts in either package.json/requirements. `DEVELOPMENT_SPEC.md` §8 lists 80% coverage / ESLint / Ruff as goals — these are aspirational, not implemented; do not introduce a test/lint stack unless explicitly asked.

## ⚠️ Setup gotchas (read before installing)

1. **`douyin-mcp-server/` is gitignored** — `.gitignore:33` excludes it but `backend/app/services/video_extractor.py:65` imports `DouyinProcessor` from there. After cloning the main repo, also `git clone https://github.com/yzfly/douyin-mcp-server.git` into the project root.
2. **`requirements.txt` is incomplete for ASR** — `local_asr.py` needs `funasr`, `faster-whisper`, `torch`, `numpy`, `imageio-ffmpeg`, and `modelscope`, none of which are in `requirements.txt`. Install them separately: `pip install funasr faster-whisper torch torchaudio numpy imageio-ffmpeg modelscope`.
3. **`.env.example` and `app/core/config.py` disagree** — code is the source of truth:
   - `config.py` reads `LLM_API_KEY` and `LLM_API_BASE`; `.env.example` only mentions `DEEPSEEK_API_KEY`. If you set just `DEEPSEEK_API_KEY` your LLM call will silently fall back to the `mimo-v2.5-pro` default at `xiaomimimo.com`. Set `LLM_API_KEY=<same value>` and `LLM_API_BASE=` (empty) to use DeepSeek directly.
   - `config.py` uses `HOST`/`PORT`; `.env.example` has `BACKEND_HOST`/`BACKEND_PORT` — those names are read by `start.sh`, not by FastAPI.
4. **Python 3.13 + funasr** — funasr/torch wheels may not yet support 3.13 cleanly; if installs fail, drop to Python 3.11 or 3.12.
5. **README/DEVELOPMENT_SPEC mention "Next.js 15"** — actual is Next.js **16.2.7** + React **19.2.4** (see `frontend/package.json`). Treat README versions as stale.

## OpenSpec workflow

The project uses OpenSpec for change tracking (`openspec/changes/`, `.claude/skills/openspec-*`, `.claude/commands/opsx`). For any new feature/spec change, the convention is **propose → apply → archive**, not direct edits to `openspec/specs/`. The skills `openspec-propose`, `openspec-apply-change`, and `openspec-archive-change` are wired up under `.claude/skills/`.

## Monorepo layout

```
backend/          FastAPI app (port 8000) — video extraction, AI juicer, SQLite persistence
frontend/         Next.js 16 App Router (port 3000) — all client components, TailwindCSS v4
douyin-mcp-server/  Cloned dependency; backend imports DouyinProcessor from it
openspec/         OpenSpec change tracking (specs/ + changes/)
.env.example      Required env vars template (copy to .env)
```

## Core data flow (the "pipeline")

`POST /api/extract` (and the SSE variant `GET /api/extract/stream`) run a sequential pipeline:
1. **Parse** — `video_extractor.parse_video_info(url)` resolves the Douyin share link to metadata
2. **Transcribe** — primary: SiliconFlow ASR API (via douyin-mcp-server); fallback: local FunASR paraformer-large → faster-whisper
3. **AI generate** — `ai_juicer.detect_content_type()` (keyword heuristic) → `ai_juicer.generate_card()` (LiteLLM call to DeepSeek-V3, returning structured JSON: `{sections, conclusion, pitfall_rating}`). For `plan`-type content, `ai_juicer.generate_plan()` produces a structured plan (fields + days + tasks) instead.
4. **Persist** — `note_service.create_note()` writes to SQLite `notes` table; if a plan was generated, `plan_service.create_plan()` also writes a row to the `plans` table linked by `note_id`. Response includes the full `to_dict()` serialization.

**Streaming variant:** `/api/extract/stream` returns `text/event-stream` with one SSE event per pipeline step (`{"step","message","status"}`). The frontend `ExtractionContext` + `PipelineProgress` component consume these to show live progress on the `process` page.

## Backend architecture

```
backend/app/
  main.py              FastAPI app factory — CORS (*), router, auto-creates tables on startup
  core/config.py       Pydantic-settings: DATABASE_URL, LLM_MODEL/API_BASE/API_KEY, ASR config
  core/database.py     SQLAlchemy engine + session factory + get_db() dependency
  models/note.py       Note ORM — single `notes` table, ai_summary is JSON-encoded text, to_dict() deserializes it
  models/plan.py       Plan ORM — `plans` table, linked to notes via note_id (FK, ondelete SET NULL); JSON-encoded fields/days/tasks, schema_version bump on shape changes
  api/routes.py        All endpoints (see below), standard response envelope {success, data, error}
  services/
    video_extractor.py   Wraps douyin-mcp-server + local ASR fallbacks
    ai_juicer.py         Content-type detection + LiteLLM prompt + completion (card + plan generation)
    local_asr.py         FunASR/faster-whisper unified transcribe() interface
    note_service.py      CRUD + SEO slug/title generation
    plan_service.py      Plan CRUD + task toggle/add/delete + stats; creates plans from plan-type cards
```

**API endpoints:**
- `GET /api/health` — liveness
- `POST /api/video/info` — parse URL, return metadata (no download)
- `POST /api/extract` — full pipeline (parse → transcribe → AI → save)
- `GET /api/extract/stream` — same pipeline as SSE `text/event-stream` with per-step progress events
- `GET /api/notes?page=&per_page=` — paginated list
- `GET /api/notes/{id}` — single note
- `GET /api/plans` · `GET /api/plans/stats` · `GET /api/plans/{id}` — plan list/stats/detail
- `POST /api/plans/{id}/tasks` · `PATCH /api/plans/{id}/tasks/{tid}` · `DELETE /api/plans/{id}/tasks/{tid}` · `DELETE /api/plans/{id}` — plan task CRUD + delete
- `GET /api/video/proxy` — proxies Douyin video play URLs with the required headers; if `note_id` given and the stored URL expired, re-parses the share link for a fresh URL

**Response envelope:** `{success: bool, data: T | null, error: string | null}`

**LLM config:** Uses LiteLLM as a proxy layer. Default model is `mimo-v2.5-pro` via `https://token-plan-cn.xiaomimimo.com/anthropic` (Anthropic-compatible endpoint). Configurable via `LLM_MODEL`, `LLM_API_BASE`, `LLM_API_KEY` in `.env`.

**Database:** SQLite (`videocapsule.db` in backend root), SQLAlchemy ORM. Designed for future PostgreSQL migration — use SQLAlchemy's dialect abstraction.

## Frontend architecture

> Sub-directory instructions live in `frontend/AGENTS.md` (a one-line `frontend/CLAUDE.md` just imports it). The key rule there: this is **Next.js 16**, not the version your training data knows — read `node_modules/next/dist/docs/` before relying on remembered APIs.

```
frontend/src/
  app/
    layout.tsx          Root layout — inter font, glass nav, theme toggle, QR modal, footer, BottomTabBar (mobile)
    page.tsx            Home — 'use client', InputBar → CardRenderer, loading skeleton, homeCategories
    process/page.tsx    Extraction-in-progress + result detail view; consumes SSE via ExtractionContext, shows PipelineProgress + TranscriptViewer
    plans/page.tsx      Plans list + detail (via ?id=), task toggle/add, progress stats
    notes/page.tsx      Notes list + detail (via ?id= query param), pagination
    settings/page.tsx   App settings (theme, ASR/LLM prefs surfaced via SettingsContext)
    style/page.tsx      Card-style picker for the multi-layout card system
    Providers.tsx       Client providers root (ExtractionContext, SettingsContext)
    globals.css         ALL styles — CSS custom properties for dark/light themes, glassmorphism, animations
  components/
    InputBar.tsx        URL input with paste detection
    CardRenderer.tsx    Full card — header, sections, conclusion, export; double-bezel glass borders; delegates to a card-styles/* layout
    CardSection.tsx / SectionIcon.tsx   Section rendering with emoji/icon
    Conclusion.tsx / PitfallRating.tsx  Takeaway box + 5-star rating
    card-styles/        Swap-in card layouts: Standard, CompactList, Creative, Hero, Magazine, Minimal — chosen via the style system
    StyleToolbar.tsx    In-card style switcher
    PipelineProgress.tsx / TranscriptViewer.tsx   Live extraction progress + transcript display
    PlanCard.tsx / PlanTaskList.tsx / PlanDynamicField.tsx   Plan rendering + interactive task list + dynamic field renderer
    BottomTabBar.tsx / BottomSheet.tsx / GlobalSheetManager.tsx   Mobile tab nav + bottom-sheet system (GlobalSheetManager is the singleton controller other components open sheets through)
    ThemeToggle.tsx     Dark/light with localStorage persistence
    ExportButton.tsx    → PNG via html2canvas
    QRModal.tsx / QRCodeDownload.tsx / MobileDownloadButton.tsx / AndroidBanner.tsx
  lib/
    api.ts              fetch wrappers: extractVideo(), getVideoInfo(), listNotes(), getNote(), listPlans/getPlan/deletePlan, plan task ops
    types.ts            CardData, CardSection, Note, NoteDetail, PlanData, PlanDay, ApiResponse, PaginatedResponse, CARD_TYPE_CONFIG + plan progress helpers (getPlanCurrentDay/getPlanProgress/getTodayTasks)
    homeCategories.ts   Home-screen category config
    hooks/              ExtractionContext (SSE pipeline state), SettingsContext, useLocalStorage, useMediaQuery
```

**Important frontend facts:**
- **Next.js 16 / React 19** — the `frontend/AGENTS.md` warns: APIs and conventions may differ from your training data. Check `node_modules/next/dist/docs/` before writing Next.js code.
- **All pages are `'use client'`** — no server components, no server actions, no SSR. This is intentional for the SPA-like UX.
- **Dev API proxy** — `next.config.ts` rewrites `/api/*` → `http://localhost:8000/api/*` in dev mode. In production/static-export mode, set `NEXT_PUBLIC_API_URL` and the API client uses that.
- **Capacitor Android builds** use `output: 'export'` (static export) with `NEXT_PUBLIC_API_URL=http://10.0.2.2:8000` for Android emulator access to host localhost.
- **Styling** is TailwindCSS v4 (not v3 — `@import "tailwindcss"` in CSS, no `tailwind.config.ts` needed). The design system uses glassmorphism with double-bezel borders, emerald green accent (`#10b981`), and dark base (`#0a0a0f`). Full spec in `DESIGN.md`.

## Card types

Five content types detected by keyword matching in `ai_juicer.detect_content_type()`:

| Type | Label | Color accent |
|------|-------|-------------|
| `recipe` | 美食菜谱 | Orange |
| `insight` | 认知金句 | Emerald |
| `history` | 历史科普 | Amber |
| `product` | 好物推荐 | Rose |
| `general` | 通用知识 | Slate |

## Key constraints

- **Primary language is Chinese** — all UI text, code comments, API descriptions, and LLM prompts are in Chinese.
- **Douyin-only** — the video extractor targets Douyin (抖音) share links. YouTube/Bilibili are aspirational targets, not yet implemented.
- **SQLite for MVP** — no concurrent-write safety. The plan is to migrate to PostgreSQL.
- **No authentication** — the app is single-user/local. CORS is wide open.
- **No tests configured** — the DEVELOPMENT_SPEC.md references 80% coverage goals and ESLint/Ruff, but these are not yet set up.
- **`.modelcache/`** in the backend contains FunASR model files (~1-2 GB when downloaded). Do not commit it.

## Environment setup

Copy `.env.example` → `.env` and fill in:
- `API_KEY` — SiliconFlow API key for primary ASR
- `LLM_API_KEY` — API key for the LLM endpoint (DeepSeek or Anthropic-compatible)
- `LLM_MODEL` — model identifier (default `mimo-v2.5-pro`; use `deepseek/deepseek-chat` for DeepSeek)
- `LLM_API_BASE` — LiteLLM-compatible base URL

See `.env.example` for all variables. FFmpeg must be installed on the host system (or bundled via `imageio-ffmpeg` on Windows).
