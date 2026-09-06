# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project identity

知萃 (Zhicui / VideoCapsule) — turn long Douyin/Bilibili videos, WeChat 公众号 articles, and 小红书 notes into structured knowledge cards. Paste a URL, the app routes by platform, extracts text (ASR for video, direct scrape for articles/notes), an LLM "mini agent chain" generates a formatted card (sections + conclusion + pitfall rating) and optionally an actionable plan, and the result is saved per-user. The UI is Chinese-first, mobile-first, dark-glassmorphism. Deployed at **https://luxai.cn** with JWT auth + an admin panel.

## Commands

```bash
# Backend (Python 3.12, pip)
cd backend
pip install -r requirements.txt
python run.py                    # starts uvicorn on :8000 with reload

# Frontend (Next.js 16, npm)
cd frontend
npm install
npm run dev                      # Next.js dev server on :3000 (proxies /api/* → :8000)
npm run build                    # production build
npm run cap:build                # static export + Capacitor Android sync (API → 10.0.2.2:8000 for emulator)
npm run cap:build:prod           # same, but API → https://luxai.cn for production APK

# All-in-one startup
./start.sh                       # macOS/Linux — installs deps, starts backend then frontend
start.bat                        # Windows equivalent

# Local APK build (server has no Android SDK — build locally, push to git, Jenkins auto-syncs)
bash scripts/build-apk.sh        # cap:build:prod → gradle assembleDebug → copy apk → git push
```

No test runner or linter is configured. There are no `test`/`lint` scripts in either `package.json` or `requirements.txt`. `DEVELOPMENT_SPEC.md` §8 lists 80% coverage / ESLint / Ruff as goals — these are aspirational, not implemented; do not introduce a test/lint stack unless explicitly asked.

## ⚠️ Setup gotchas (read before installing)

1. **`douyin-mcp-server/` is gitignored** — `.gitignore` excludes it but `backend/app/services/video_extractor.py:67` imports `DouyinProcessor` from there. After cloning the main repo, also `git clone https://github.com/yzfly/douyin-mcp-server.git` into the project root.
2. **`requirements.txt` is incomplete for local ASR** — the local fallback (`local_asr.py`) needs `funasr`, `faster-whisper`, `torch`, `numpy`, `imageio-ffmpeg`, and `modelscope`, none of which are in `requirements.txt`. Install separately: `pip install funasr faster-whisper torch torchaudio numpy imageio-ffmpeg modelscope`. The **primary** ASR is the SiliconFlow API (model `FunAudioLLM/SenseVoiceSmall`); local ASR is only the fallback. The slim server dep set (`deploy/requirements-server.txt`) drops torch/funasr entirely and relies on API ASR.
3. **`.env.example` is stale — code is the source of truth** (`backend/app/core/config.py` reads these exact names):
   - `config.py` reads `LLM_API_KEY` and `LLM_API_BASE`; `.env.example` only mentions `DEEPSEEK_API_KEY`. Set `LLM_API_KEY=<same value>` and `LLM_API_BASE=` (empty) to use DeepSeek directly. Default model is `mimo-v2.5-pro` (an Anthropic-compatible endpoint) — leave `LLM_API_BASE` empty and `LLM_API_KEY` unset to fall back to it.
   - `config.py` uses `HOST`/`PORT`; `.env.example` has `BACKEND_HOST`/`BACKEND_PORT` — those names are read by `start.sh`, not by FastAPI.
   - `.env.example` is missing **`JWT_SECRET`** (required — the app raises `RuntimeError` at import if unset), **`ENCRYPTION_KEY`** (Fernet key for encrypting admin-configured API keys in the DB), and **`XHS_COOKIE`** (cookie for 小红书 note scraping). See **Environment setup** below.
4. **`JWT_SECRET` is hard-required** — `auth_service.py` raises at import time if `JWT_SECRET` is empty. Generate with `python -c "import secrets; print(secrets.token_hex(32))"`.
5. **First registered user auto-becomes admin.** There is no seed/superuser script. To make an existing user admin in prod: `sudo -u postgres psql zhicui -c "UPDATE users SET is_admin=true WHERE email='x';"` then restart the backend.
6. **Python 3.13 + funasr** — funasr/torch wheels may not support 3.13 cleanly; if local-ASR installs fail, drop to Python 3.11 or 3.12.
7. **README/DEVELOPMENT_SPEC mention "Next.js 15"** — actual is Next.js **16.2.7** + React **19.2.4** (see `frontend/package.json`). Treat README versions as stale.
8. **Default SQLite file is `zhicui.db`** (in `config.py`), **not** `videocapsule.db` as the stale `.env.example` claims. Prod uses PostgreSQL (`postgresql://zhicui:...@localhost:5432/zhicui`).

## Change workflow

按项目所有者要求，直接实现需求、运行相关测试并记录发布结果，不再使用 OpenSpec 或生成提案/归档目录。重要验收和待办记录放在 `docs/` 或 `deploy/`；生产权限、签名、备份和发布验证仍按现有脚本执行，不因移除文档工作流而跳过。

## Monorepo layout

```
backend/          FastAPI app (port 8000) — multi-platform extraction, AI juicer, auth, admin, SQLite/PG
frontend/         Next.js 16 App Router (port 3000) — all client components, TailwindCSS v4
douyin-mcp-server/  Cloned dependency; backend imports DouyinProcessor from it
deploy/           systemd units, nginx conf, deploy.sh, requirements-server.txt (slim prod deps)
scripts/          build-apk.sh — local APK build (server lacks Android SDK)
.env.example      Stale env template (see gotchas) — copy to .env and fix per config.py
```

## Core data flow (the "pipeline")

`POST /api/extract` and the SSE variant `GET /api/extract/stream` (both require auth) run a **platform-dispatched** pipeline. `video_extractor._detect_platform(url)` routes first:

- **`wechat`** (mp.weixin.qq.com) — `wechat_extractor.extract_wechat_article()` scrapes the 公众号 article; the **article text IS the transcript** (no ASR).
- **`xiaohongshu`** (xiaohongshu.com / xhslink.com) — `xhs_extractor.parse_xhs_note()` + `extract_xhs_content()` scrape the note using the `XHS_COOKIE` env var; **note text IS the transcript**.
- **`douyin` / `bilibili`** (and `unknown`) — the video path below.

**Video path** (douyin/bilibili):
1. **Parse** — `video_extractor.parse_video_info(url)` resolves metadata + download URL.
2. **Transcribe** — config comes from `settings_service.get_asr_config(db)` (DB runtime value, `.env` fallback). Primary: SiliconFlow ASR API. Fallback: local FunASR/faster-whisper via `fallback_local_asr()`. If both fail, an **image-frame fallback** kicks in: `ai_juicer.extract_video_frames()` grabs stills → `generate_card_from_images()` analyzes them visually.
3. **AI generate — mini agent chain** (in `ai_juicer.py`):
   - `classify_intent(transcript)` → LLM call returning `{card_type, is_plan}`
   - if `is_plan`: `generate_plan(transcript)` → structured plan (goal + fields + days + tasks)
   - `generate_card(transcript, content_type, title)` → LiteLLM call returning structured JSON `{sections, conclusion, pitfall_rating, tone, density, hero_quote, key_insight, stats}`
   - (The legacy keyword-based `detect_content_type()` still exists and is used by the admin **re-extract** endpoint, not the live pipeline.)
4. **Persist** — `note_service.create_note(db, video_info, transcript, ai_result, user_id)` writes a `notes` row scoped to `current_user.id`. If a plan was generated, `ai_juicer.plan_to_storage()` normalizes it and `plan_service.create_plan()` writes a `plans` row linked by `note_id` and `user_id`.

**Streaming variant:** `/api/extract/stream` returns `text/event-stream` with one SSE event per step (`{"step","message","status"}`, final `step:"done"` carries the note). The frontend `ExtractionContext` + `PipelineProgress` consume these on the `process` page. Both wechat and video paths have their own SSE event sequences.

## Backend architecture

```
backend/app/
  main.py              FastAPI app factory — CORS (*), router, create_all + _migrate_db() on startup
  core/config.py       Pydantic-settings: DATABASE_URL, LLM_*, ASR_*, JWT_SECRET, ENCRYPTION_KEY, HOST/PORT
  core/database.py     SQLAlchemy engine + session factory + get_db() dependency
  core/auth.py         FastAPI deps: get_current_user (401), get_current_user_optional, get_current_admin (403)
  models/
    user.py            User ORM — email + username + hashed_password + is_active + is_admin; first user→admin
    note.py            Note ORM — notes table, user_id FK (CASCADE), ai_summary is JSON-encoded text, to_dict() deserializes
    plan.py            Plan ORM — plans table, linked to notes via note_id AND to users via user_id; JSON-encoded fields/days/tasks
    system_setting.py  SystemSetting ORM — key/value store for runtime LLM/ASR config
    admin_audit_log.py AdminAuditLog ORM — admin actions (promote/disable/delete/config-change/re-extract…)
  api/routes.py        All endpoints (see below), standard envelope {success, data, error}
  services/
    video_extractor.py   _detect_platform() + Douyin/Bilibili parse + ASR with local fallback + ffmpeg path patch
    wechat_extractor.py  公众号 article → {video_id, title, download_url, content}
    xhs_extractor.py     小红书 note → parse_xhs_note() / extract_xhs_content() (needs XHS_COOKIE)
    ai_juicer.py         Mini agent chain: classify_intent → generate_plan → generate_card; image-frame fallback; plan_to_storage()
    auth_service.py      JWT (HS256, 30-day) + werkzeug password hashing; register() (first user→admin) + login() (email OR username)
    settings_service.py  Runtime LLM/ASR config — DB value overrides .env (no restart); secrets Fernet-encrypted at rest via ENCRYPTION_KEY
    audit_service.py      log_action() for every admin mutation; list_audit_logs() viewer
    local_asr.py         FunASR/faster-whisper unified transcribe() interface (fallback only)
    note_service.py      CRUD + SEO slug/title; user-scoped list/get; admin list/delete/re-extract/update_ai
    plan_service.py      Plan CRUD + task toggle/add/delete + stats; user_id-scoped
```

**Auth model:** Email+password, JWT in `Authorization: Bearer <token>` (HS256, 30-day expiry). Passwords hashed with werkzeug. `core/auth.py` exposes three FastAPI dependencies used pervasively: `get_current_user` (required, 401 on missing/invalid), `get_current_user_optional` (returns None if no token — used only by `/api/video/info`), `get_current_admin` (403 if not admin). All user-facing list/get endpoints filter by `current_user.id` — data is per-user.

**Response envelope:** `{success: bool, data: T | null, error: str | null}`.

**Runtime config (no-restart hot-swap):** `settings_service` resolves effective LLM/ASR config as **DB value → `.env` fallback**. The admin panel writes to the `system_settings` table; `ai_juicer._get_llm_config()` opens a short-lived `SessionLocal()` to read it at call time (ai_juicer functions carry no DB arg). Secret keys (`llm_api_key`, `asr_api_key`) are **Fernet-encrypted at rest** (prefixed `ENC:`) using `ENCRYPTION_KEY` from `.env`, so a DB backup leak does not expose plaintext. Non-secret values (model names, api_base URLs) stay plaintext. `get_llm_config()` falls back through DB-decrypted-key → `LLM_API_KEY` → `API_KEY` (so a single SiliconFlow key still works for both).

**API endpoints:**
- `GET /api/health` — liveness
- **Auth:** `POST /api/auth/register` · `POST /api/auth/login` (email **or** username) · `GET /api/auth/me`
- `POST /api/video/info` — parse URL, return metadata (optional auth)
- `POST /api/extract` · `GET /api/extract/stream` — full pipeline (auth required, user-scoped)
- `GET /api/notes?page=&per_page=` · `GET /api/notes/{id}` — user-scoped note list/detail
- `GET /api/plans` · `/stats` · `/{id}` · `POST /{id}/tasks` · `PATCH /{id}/tasks/{tid}` · `DELETE /{id}/tasks/{tid}` · `DELETE /{id}` — plan CRUD (user-scoped)
- `GET /api/video/proxy` — proxies Douyin video play URLs with required headers; refreshes expired URLs via `note_id`
- **Admin (`/api/admin/*`, all guarded by `get_current_admin`, all mutations audit-logged):** `GET /stats`; user mgmt `GET/PATCH/DELETE /users`, `GET /users/{id}` (detail), `POST /users/{id}/reset-password`; runtime config `GET/PUT /llm-config` + `/asr-config`, `POST /llm-config/test` + `/asr-config/test`; note mgmt `GET /notes`, `DELETE /notes/{id}`, `POST /notes/{id}/re-extract`, `POST /notes/batch-delete`; plan mgmt `GET /plans`, `DELETE /plans/{id}`; `GET /audit-logs`; `GET /system-info`; `GET /ops` (health + table counts + recent audit). Self-disable / self-demote is blocked; demoting the last active admin is blocked.

**Admin guards worth remembering:** you cannot disable or demote yourself, and you cannot remove the last enabled admin — both return `_err(...)` rather than mutating.

**Database:** SQLite (`zhicui.db` in backend root) for dev, PostgreSQL 16 in prod. SQLAlchemy ORM throughout, designed for dialect portability. `main._migrate_db()` adds `username`/`is_admin` columns to an existing `users` table on startup (SQLite `ALTER TABLE`) — there is no Alembic migration stack.

## Frontend architecture

> `frontend/AGENTS.md` warns: this is **Next.js 16**, not the version your training data knows — read `node_modules/next/dist/docs/` before relying on remembered APIs.

```
frontend/src/
  app/
    layout.tsx          Root layout — inter font, glass nav (AppHeader), theme toggle, QR modal, footer, BottomTabBar (mobile)
    page.tsx            Home — 'use client', InputBar → CardRenderer, loading skeleton, homeCategories
    login/page.tsx      Email/username + password; redirects admins to /admin after login
    process/page.tsx    Extraction-in-progress + result detail; consumes SSE via ExtractionContext
    plans/page.tsx      Plans list + detail (?id=), task toggle/add, progress stats
    notes/page.tsx      Notes list + detail (?id=), pagination
    admin/page.tsx      Admin panel — users, notes (incl. re-extract/batch-delete), plans, audit log, runtime LLM/ASR config + test, ops/system-info
    settings/page.tsx   App settings (theme, ASR/LLM prefs surfaced via SettingsContext)
    style/page.tsx      Card-style picker for the multi-layout card system
    error.tsx / global-error.tsx
    Providers.tsx       Client providers root (AuthProvider, ExtractionContext, SettingsContext)
    globals.css         ALL styles — CSS custom properties for dark/light themes, glassmorphism, animations
  components/
    AppHeader.tsx       Top nav — shows username + 「管理端」 link for admins; wraps login/register buttons
    AuthGuard.tsx       Redirects to /login when no token (guards protected pages)
    InputBar.tsx        URL input with paste detection + multi-platform support
    CardRenderer.tsx    Full card — delegates to a card-styles/* layout; double-bezel glass borders
    card-styles/        Swap-in layouts: Standard, CompactList, Creative, Hero, Magazine, Minimal
    PipelineProgress.tsx / TranscriptViewer.tsx   Live extraction progress + transcript display
    PlanCard.tsx / PlanTaskList.tsx / PlanDynamicField.tsx   Plan rendering + interactive task list
    BottomTabBar.tsx / BottomSheet.tsx / GlobalSheetManager.tsx   Mobile tab nav + bottom-sheet system
    ExportButton.tsx    → PNG via html2canvas
    QRModal.tsx / QRCodeDownload.tsx / MobileDownloadButton.tsx / AndroidBanner.tsx
  lib/
    api.ts              fetch wrappers — authHeaders() attaches `Bearer <zhicui_token>` to EVERY call; unwraps {success,data,error}; admin API client
    types.ts            CardData, Note, PlanData, ApiResponse, etc.
    hooks/              AuthContext (login/register/logout, restores session from localStorage), ExtractionContext (SSE state), SettingsContext, useLocalStorage, useMediaQuery
```

**Important frontend facts:**
- **Next.js 16 / React 19** — check `node_modules/next/dist/docs/` before writing Next.js code; conventions may differ from training data.
- **All pages are `'use client'`** — no server components, no server actions, no SSR. Intentional for SPA-like UX.
- **Auth is client-side** — `AuthContext` stores the JWT in `localStorage` under `zhicui_token`, restores the session by calling `/api/auth/me` on mount, and `api.ts`'s `authHeaders()` auto-attaches the bearer to every request. `AuthGuard` gates protected pages. There is no server-side session or cookie.
- **Dev API proxy** — `next.config.ts` rewrites `/api/*` → `http://localhost:8000/api/*` in dev. In static-export/Capacitor mode, `NEXT_PUBLIC_API_URL` is baked in at build time (`10.0.2.2:8000` for emulator, `https://luxai.cn` for prod).
- **Capacitor Android builds** use `output: 'export'` (static export). `cap:build` and `cap:build:prod` npm scripts set the right `NEXT_PUBLIC_API_URL`. The `CAPACITOR_BUILD=true` env syntax fails in Windows cmd — use Git Bash (`bash scripts/build-apk.sh`).
- **Styling** is TailwindCSS v4 (`@import "tailwindcss"`, no `tailwind.config.ts`). Glassmorphism, double-bezel borders, emerald accent (`#10b981`), dark base (`#0a0a0f`). Full spec in `DESIGN.md`. Default theme is **light** mode.

## Card types

Six content types (the live pipeline uses LLM `classify_intent`; the keyword heuristic `detect_content_type` is the legacy/admin path):

| Type | Label | Color accent |
|------|-------|-------------|
| `recipe` | 美食菜谱 | Orange |
| `insight` | 认知金句 | Emerald |
| `history` | 历史科普 | Amber |
| `product` | 好物推荐 | Rose |
| `plan` | 行动计划 | — (generates a Plan, not just a card) |
| `general` | 通用知识 | Slate |

## Key constraints

- **Primary language is Chinese** — all UI text, code comments, API descriptions, and LLM prompts are in Chinese.
- **Multi-platform, not Douyin-only** — `_detect_platform()` supports Douyin, Bilibili (video → ASR), WeChat 公众号 (article → text), and 小红书 (note → text via `XHS_COOKIE`). YouTube is still aspirational.
- **Auth is required** — JWT (30-day, HS256). All data endpoints are user-scoped. First registered user becomes admin. The old "no-auth, single-user" MVP constraint no longer applies.
- **SQLite for dev, PostgreSQL for prod** — SQLAlchemy dialect abstraction throughout. No concurrent-write safety in SQLite dev.
- **CORS is wide open in dev** (`*`); configurable via `ALLOWED_ORIGINS` in prod.
- **No tests configured** — DEVELOPMENT_SPEC.md references 80% coverage / ESLint / Ruff goals, not yet set up.
- **`.modelcache/`** in the backend holds FunASR model files (~1–2 GB when downloaded). Do not commit it.

## Environment setup

Copy `.env.example` → `.env` and fill in (note: `.env.example` itself is stale — use `config.py` as the source of truth for variable names):

- `API_KEY` — SiliconFlow API key (primary ASR; also the fallback for LLM if no `LLM_API_KEY`)
- `LLM_API_KEY` — API key for the LLM endpoint (DeepSeek or Anthropic-compatible)
- `LLM_MODEL` — model identifier (default `mimo-v2.5-pro`; use `deepseek/deepseek-chat` for DeepSeek)
- `LLM_API_BASE` — LiteLLM-compatible base URL (empty = use model's default endpoint)
- `JWT_SECRET` — **required**, random hex; `python -c "import secrets; print(secrets.token_hex(32))"`. App refuses to start without it.
- `ENCRYPTION_KEY` — Fernet key for encrypting admin-configured LLM/ASR API keys in the DB; `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Optional but strongly recommended in prod.
- `XHS_COOKIE` — cookie string for scraping 小红书 notes (only needed for the xiaohongshu path)
- `DATABASE_URL` — `sqlite:///./zhicui.db` (dev) or `postgresql://zhicui:<password>@localhost:5432/zhicui` (prod)
- `ALLOWED_ORIGINS` — comma-separated origins for CORS (default `*` in dev)
- `HOST` / `PORT` — FastAPI bind (`0.0.0.0` / `8000`); `.env.example`'s `BACKEND_HOST`/`BACKEND_PORT` are read by `start.sh` only

The admin panel can override `LLM_*` and `ASR_*` at runtime via the `system_settings` table (no restart); those DB values take precedence over `.env`. FFmpeg must be on the host PATH (or bundled via `imageio-ffmpeg` on Windows — `video_extractor._patch_ffmpeg_path()` handles this).

## Production deployment (腾讯云 + Gitee + Jenkins CI/CD)

Live at **https://luxai.cn** on Tencent Cloud Lighthouse (`124.223.193.227`, Ubuntu 24.04). Full architecture and operational runbook in user memory `zhicui-deployment.md`; essentials:

**Stack:** FastAPI (uvicorn :8000, systemd `videocapsule-backend`) + Next.js (next start :3000, systemd `videocapsule-frontend`) + Nginx (80/443 → 3000/8000, SSE-aware) + PostgreSQL 16 (`zhicui` db/user, port 5432 open for remote Navicat). Slim backend deps (`deploy/requirements-server.txt` — drops torch/funasr, adds psycopg2-binary). HTTPS via Let's Encrypt certbot (auto-renew).

**CI/CD:** GitHub `kyirexy/zhicui` → Gitee `liu-xiangyu-0725/zhicui` mirror. Gitee Push webhook → Jenkins (`:8080`, Java 21, Generic Webhook Trigger, token stored outside git) → `deploy/deploy.sh` (git pull + pip install + npm build + systemctl restart + health-check loop 60s). Local flow: `git push gitee master` → auto deploy. **Never run git on `/opt/zhicui` as root** — root-owned `.git/objects` break jenkins `git pull`; use `sudo -u ubuntu` or let Jenkins do it. Fix: `sudo chown -R ubuntu:ubuntu /opt/zhicui`.

**APK:** `frontend/public/download/zhicui.apk` (~33MB debug), API points to `https://luxai.cn`. Server has no Android SDK — **build APK locally** with `bash scripts/build-apk.sh` (Next export → cap sync → gradle assembleDebug → copy → git push, Jenkins auto-syncs). The `cap:build:prod` npm script sets `NEXT_PUBLIC_API_URL=https://luxai.cn`; `CAPACITOR_BUILD=true` env syntax fails in Windows cmd — use Git Bash. Download: https://luxai.cn/download/zhicui.apk.

**Auth & admin:** JWT (30-day), registration requires unique `username`, **first registered user auto-becomes admin**. Admin sees 「管理端」link in header → `/admin` (user list/disable/delete/reset-password, note mgmt + re-extract, plan mgmt, audit log, runtime LLM/ASR config + connection test, ops dashboard). Login accepts email or username.

**Server ops (SSH `ubuntu@124.223.193.227`):**
- Logs: `sudo journalctl -u videocapsule-backend -f` / `-u videocapsule-frontend -f`
- Restart: `sudo systemctl restart videocapsule-backend` / `videocapsule-frontend`
- Health: `curl http://127.0.0.1:8000/api/health`
- `.next` 502/permission: `sudo chown -R ubuntu:ubuntu /opt/zhicui/frontend/.next && sudo chmod -R a+r /opt/zhicui/frontend/.next`; if still broken: `cd /opt/zhicui/frontend && sudo rm -rf .next && sudo -u ubuntu npm run build`
- PG: `sudo -u postgres psql zhicui`; make user admin: `UPDATE users SET is_admin=true WHERE email='x';` + restart backend
- Nginx: `/etc/nginx/sites-available/nginx-videocapsule.conf` → `sudo nginx -t && sudo systemctl reload nginx`

**Tencent Cloud firewall open:** 80/443 (Nginx), 8080 (Jenkins), 5432 (PostgreSQL for remote Navicat).
