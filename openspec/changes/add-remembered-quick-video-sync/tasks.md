## 1. Preference model

- [x] 1.1 Add a shared validated local preference module for quick-sync sources, count, confirmation state, and change notifications
- [x] 1.2 Migrate the video library to the shared preference module while preserving existing stored choices

## 2. Quick entry behavior

- [x] 2.1 Consume the homepage `sync=1` intent once and open settings for first-time users
- [x] 2.2 Wait for account state and directly run saved preferences for returning users, with dialog fallback when the account is unavailable

## 3. Settings experience

- [x] 3.1 Add a clean quick-sync settings card for editing sources and bounded count
- [x] 3.2 Support saving direct-sync preferences and requiring confirmation on the next invocation

## 4. Verification

- [x] 4.1 Verify TypeScript and production build
- [ ] 4.2 Verify first-use, returning-use, settings-change, and disconnected-account flows in the running app

## 5. Homepage video deep links

- [x] 5.1 Preserve the exact Douyin or imported-video identifier in every homepage preview link
- [x] 5.2 Verify homepage previews open their corresponding video detail routes

## 6. Homepage video covers

- [x] 6.1 Reuse the resilient library cover loader for homepage video previews
- [x] 6.2 Verify Douyin and Bilibili covers render in the running desktop homepage

## 7. Video-first homepage layout

- [x] 7.1 Compress the homepage assistant entry and place channel video previews before secondary tools
- [x] 7.2 Present Douyin works, collections, likes, and Bilibili previews in a responsive, directly clickable layout
- [ ] 7.3 Verify all four channels remain visible and usable across desktop and mobile breakpoints
