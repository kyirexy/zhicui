## 1. Desktop project foundation

- [x] 1.1 Create the Electron TypeScript project, package scripts and NSIS x64 builder configuration
- [x] 1.2 Create a secure single-instance BrowserWindow that loads the configured Zhicui origin
- [x] 1.3 Register and handle `zhicui://` deep links
- [x] 1.4 Add packaged app version and GitHub Release update-check support

## 2. Secure desktop bridge

- [x] 2.1 Add a context-isolated preload API and shared TypeScript contract
- [x] 2.2 Restrict renderer navigation, popups and IPC callers to trusted origins
- [x] 2.3 Validate short-lived handoff inputs and exact callback origins in the main process

## 3. Local Douyin login

- [x] 3.1 Launch installed Chrome with an isolated temporary profile and visible login page
- [x] 3.2 Fall back to Microsoft Edge when Chrome is unavailable
- [x] 3.3 Detect bounded authenticated Douyin Cookie evidence without logging Cookie values
- [x] 3.4 Submit the signed handoff, report success/failure, support cancellation and clean the temporary profile

## 4. Product integration

- [x] 4.1 Detect the installed desktop runtime in the video library
- [x] 4.2 Use the preload bridge for desktop-app binding and poll the existing account-scoped backend status
- [x] 4.3 Remove automatic localhost navigation from ordinary web users and provide app open/download actions
- [x] 4.4 Update Android/mobile guidance for one-time desktop binding and cross-device use
- [x] 4.5 Add Windows desktop download metadata/entry without changing Android update behavior

## 5. Build and verification

- [x] 5.1 Install dependencies and pass Electron/TypeScript compilation
- [x] 5.2 Pass the existing frontend production build
- [x] 5.3 Build the Windows NSIS installer and inspect packaged files
- [x] 5.4 Verify callback validation, Cookie bounds, cancellation and cleanup behavior
- [x] 5.5 Validate the OpenSpec change and document code-signing/release prerequisites
