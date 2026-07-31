## ADDED Requirements

### Requirement: Desktop app performs Douyin login on the user's Windows device
The desktop application SHALL launch an isolated temporary profile in the user's installed Chrome, with Edge fallback, to complete Douyin authentication using the user's device and network.

#### Scenario: Chrome is installed
- **WHEN** a signed-in Zhicui desktop user starts Douyin binding
- **THEN** the app SHALL open a visible local Chrome window at the Douyin login page

#### Scenario: Chrome is unavailable and Edge is installed
- **WHEN** Chrome cannot be started
- **THEN** the app SHALL retry with Microsoft Edge and report the selected browser

#### Scenario: No supported browser is available
- **WHEN** neither Chrome nor Edge can be started
- **THEN** the app SHALL return a bounded user-facing error without starting a server-side browser

### Requirement: Desktop login uses a short-lived scoped handoff
The login flow MUST use a server-issued short-lived token and SHALL send its result only to the exact approved Zhicui callback.

#### Scenario: Authenticated Cookie evidence appears
- **WHEN** the temporary browser context contains recognized Douyin authenticated-session Cookie names
- **THEN** the desktop app SHALL post a bounded Cookie map with the token to the approved callback and await server validation

#### Scenario: Callback URL is untrusted
- **WHEN** a renderer supplies a callback outside the approved production or development origins and path
- **THEN** the desktop app SHALL reject the request before launching a browser

#### Scenario: Server rejects the handoff
- **WHEN** the callback reports an expired, mismatched or invalid session
- **THEN** the app SHALL show a safe failure state and SHALL NOT mark the user as bound

### Requirement: Login secrets remain outside Zhicui database and desktop business storage
The system MUST NOT write Douyin Cookie values, QR images or video files to the Zhicui database, application logs or desktop application preferences.

#### Scenario: Login succeeds
- **WHEN** the backend accepts the desktop handoff
- **THEN** Cookie values SHALL be forwarded to the user's isolated companion session while the database stores only safe binding metadata

#### Scenario: Login ends
- **WHEN** login succeeds, is cancelled, times out or the browser closes
- **THEN** the temporary browser context SHALL close and its profile directory SHALL be removed

### Requirement: Web and mobile clients avoid localhost login
Ordinary web and mobile clients SHALL NOT automatically navigate to a localhost connector when starting Douyin binding.

#### Scenario: Desktop web user starts binding
- **WHEN** the user is outside the installed desktop runtime
- **THEN** the UI SHALL offer to open the installed app and provide a Windows installer fallback

#### Scenario: Mobile user starts binding
- **WHEN** an Android or mobile web user starts binding
- **THEN** the UI SHALL explain that binding is completed once in the Windows app and then shared through the same Zhicui account
