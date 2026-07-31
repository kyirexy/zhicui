## 1. Shared product shell

- [ ] 1.1 Create one typed navigation definition for 今日行动、视频资料、AI 助手、我的知识 and adopt it in Web, Electron, and mobile navigation
- [ ] 1.2 Move settings, feedback, update, logout, Douyin connection, and admin entry into an accessible account menu
- [ ] 1.3 Reduce the mobile bottom navigation to four 44px targets and preserve active states for legacy routes
- [ ] 1.4 Add structured authentication/loading shells so protected routes never resolve to an empty page
- [ ] 1.5 Replace remaining purple/indigo workspace accents with the shared neutral and mint semantic tokens

## 2. Authenticated today workspace

- [ ] 2.1 Split the home route into an unauthenticated product introduction and an authenticated today workspace
- [ ] 2.2 Build the compact “问你的收藏” entry with current source summary and a direct path into a new Agent task
- [ ] 2.3 Show at most three real today actions using the existing plan overview API
- [ ] 2.4 Add recent synced videos, resumable Agent tasks, and recent knowledge outcomes without introducing a statistics card matrix
- [ ] 2.5 Add first-use, syncing, partial-success, empty, and inline-error states to the today workspace

## 3. Agent component boundary and shell

- [ ] 3.1 Split VideoAgentWorkspace into source, thread, conversation, artifact, automation, and runner modules with scoped styles
- [x] 3.2 Replace the permanent task-history rail with a persistent source panel and move task history into a drawer or task switcher
- [ ] 3.3 Implement the wide-screen 250–280px / flexible conversation / 330–380px artifact grid
- [ ] 3.4 Add responsive transitions that collapse the artifact panel below 1180px and the source panel below 960px without compressing answer readability
- [x] 3.5 Move automation and email digest management into a secondary sheet that is not part of the default conversation hierarchy

## 4. Agent sources, answers, and composer

- [ ] 4.1 Separate source mode from range mode in the task draft UI while retaining read compatibility for legacy source_scope threads
- [x] 4.2 Preserve the frozen current-thread source snapshot and clearly label edits as applying to the next task
- [ ] 4.3 Recompose Agent answers into direct conclusion, video-supported content, AI synthesis, external supplement, limitations, and next actions
- [ ] 4.4 Move evidence, web sources, limitations, and trace details into the evidence canvas and reduce the inline status to one compact row
- [x] 4.5 Simplify the persistent composer to source range, research boundary, textarea, and 48px send action; move advanced options into one sheet
- [ ] 4.6 Render a compact truthful status for simple questions and a staged progress view only for real long-running tasks
- [ ] 4.7 Keep optimistic send, stop-waiting, edit-and-retry, background completion, copy, and feedback behavior after the component split

## 5. Artifact canvas and unified content detail

- [ ] 5.1 Implement EvidenceCanvas using existing verified transcript and web evidence with video title, quote, document position, and available timestamp
- [ ] 5.2 Add editable KnowledgeCardCanvas and PlanCanvas adapters around the existing card and plan APIs
- [ ] 5.3 Update result actions so “保存为知识卡” and “转成行动计划” focus the artifact canvas instead of emitting long Markdown-only results
- [ ] 5.4 Extract a shared single-video workspace with 知识卡、完整文稿、AI 问答、行动计划 tabs
- [ ] 5.5 Reuse the shared workspace from library detail and legacy notes detail routes while preserving their existing URLs
- [ ] 5.6 Link transcript citations back to the shared detail, highlighted text, and video time when reliable timing exists

## 6. My knowledge workspace

- [ ] 6.1 Reframe the notes list as knowledge outcomes with 最近整理、主题集合、已转为行动、全部成果 views
- [ ] 6.2 Demote recipe, insight, history, product, plan, and general categories to secondary filters and metadata
- [ ] 6.3 Remove video sync and duplicate video-management affordances from the knowledge workspace
- [ ] 6.4 Add a persistence contract for saved multi-video topics and Agent answers, with per-user isolation and frozen source provenance
- [ ] 6.5 Route single-video cards to the shared detail and multi-video outcomes to their Agent task and artifact canvas

## 7. Goal, today, and review plan loop

- [ ] 7.1 Limit the today view to the three most relevant executable actions and show duration, owning goal, and one primary completion control
- [ ] 7.2 Replace the overdue-task dump with 今天完成、重新安排、跳过本次 decisions and an AI 调整今天 entry
- [ ] 7.3 Add a one-question-at-a-time goal clarification flow before generating complex plans
- [ ] 7.4 Refine goal cards to result, deadline, current stage, progress, next action, and source-video count
- [ ] 7.5 Refactor plan detail around current stage, today actions, next milestone, and a collapsed plan evidence/settings section
- [ ] 7.6 Build a review view from real completion, overdue, and reschedule events without inferring unavailable calendar, energy, or productivity data
- [ ] 7.7 Add a reviewable AI reschedule proposal that preserves completed work, explains changes, and writes only after user confirmation

## 8. Mobile and cross-platform behavior

- [ ] 8.1 Implement the mobile Agent as a single conversation with near-full-height source sheets and full-screen evidence/artifact views
- [ ] 8.2 Hide the mobile bottom navigation while the software keyboard is open and keep the composer above keyboard and safe-area insets
- [ ] 8.3 Update the mobile video library to a two-column grid with selection-mode actions in a bottom bar above navigation
- [ ] 8.4 Make the shared video detail collapse its player and keep the four content tabs reachable on 390px screens
- [ ] 8.5 Keep plan creation, checking, deletion, review, and AI adjustment available in the Android client with 44px targets

## 9. Cleanup and verification

- [ ] 9.1 Remove superseded Agent, knowledge, plan, and navigation overrides from globals.css after scoped modules are active
- [x] 9.2 Verify no horizontal overflow and readable text at 390×844, 768×1024, 1280×800, and 1440×900
- [ ] 9.3 Verify source snapshots, citations, knowledge saves, plan creation/adjustment, destructive confirmations, loading, empty, and error states
- [ ] 9.4 Run backend focused tests, frontend TypeScript, Next production build, Electron typecheck, and strict OpenSpec validation
- [ ] 9.5 Sync the verified static export into Capacitor Android resources without publishing or deploying
