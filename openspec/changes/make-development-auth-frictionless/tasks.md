## 1. Backend development identity

- [x] 1.1 Harden the reserved development-user creation and reuse path
- [x] 1.2 Keep the development-session endpoint behind the bypass and loopback guards
- [x] 1.3 Verify repeated development sessions reuse a valid standard JWT identity

## 2. Frontend session experience

- [x] 2.1 Add a shared development-session action to AuthContext
- [x] 2.2 Add bounded automatic retry when no valid stored session exists
- [x] 2.3 Add a one-click development entry and normal-auth fallback to the login page
- [x] 2.4 Sanitize post-login redirect targets and prevent protected-content flashes

## 3. Validation and handoff

- [x] 3.1 Run frontend type checking and production build
- [x] 3.2 Strictly validate the OpenSpec change
- [x] 3.3 Restart backend on 8011 and frontend on 3003
- [x] 3.4 Verify automatic, manual, repeated, and production-isolation authentication paths
