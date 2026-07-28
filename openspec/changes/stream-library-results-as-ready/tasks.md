## 1. Progressive extraction state

- [x] 1.1 Preserve the latest batch job snapshot and update completed video metadata on every poll
- [x] 1.2 Reduce the active polling delay and stop polling immediately when the batch reaches a terminal state
- [x] 1.3 Derive stable live counts and the most recently completed transcript results

## 2. Live result presentation

- [x] 2.1 Add a compact accessible live-progress summary above the video grid
- [x] 2.2 Improve per-card queued, active, completed, and failed styling without disrupting grid order
- [x] 2.3 Add responsive and reduced-motion styles for desktop and mobile

## 3. Verification

- [x] 3.1 Add focused checks for live progress counts and newest-completed ordering
- [x] 3.2 Run OpenSpec validation, focused checks, and the frontend production build
- [x] 3.3 Restart the local frontend and confirm the library route is reachable
