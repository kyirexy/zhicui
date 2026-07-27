## ADDED Requirements

### Requirement: Server without a physical desktop produces a scannable login QR
The companion SHALL support a private virtual-display browser mode that opens Douyin login, captures only the currently visible QR code in memory, refreshes it while login is pending, and persists the resulting Cookie after successful login.

#### Scenario: QR becomes available
- **WHEN** an authenticated Zhicui user starts Douyin login on a production server without a physical desktop
- **THEN** the login status reports that a QR image is ready and provides a version identifier without exposing Cookie values

#### Scenario: User scans successfully
- **WHEN** the user scans the displayed QR with the Douyin app and the browser receives authenticated Cookie fields
- **THEN** the companion stores the sanitized Cookie with owner-only permissions and the Zhicui UI reports login success

#### Scenario: QR cannot be captured
- **WHEN** Douyin changes the page or blocks the browser and no QR candidate can be found
- **THEN** the login task terminates with a safe actionable error instead of hanging indefinitely

### Requirement: Zhicui proxies QR data securely
Zhicui SHALL expose the QR image only through an authenticated application API and SHALL NOT proxy companion Cookie values, headers, or arbitrary files.

#### Scenario: Authenticated QR request
- **WHEN** a logged-in user requests the active QR after its status is ready
- **THEN** Zhicui returns a bounded PNG data URL and short-lived version metadata

#### Scenario: Unauthenticated QR request
- **WHEN** a caller without a valid Zhicui JWT requests the QR
- **THEN** the application denies the request

### Requirement: QR login UI is responsive and accessible
The video library SHALL display the active QR, clear scanning instructions, current status, and a labeled close action without page-level horizontal overflow on desktop or mobile.

#### Scenario: Mobile QR login
- **WHEN** a user opens扫码登录 on a narrow Capacitor or Web viewport
- **THEN** the QR scales within the available width, remains scannable, and the controls are keyboard and screen-reader identifiable

#### Scenario: Login task finishes
- **WHEN** the login succeeds, fails, is closed, or times out
- **THEN** the QR card is removed and stale image data is not retained in the visible interface
