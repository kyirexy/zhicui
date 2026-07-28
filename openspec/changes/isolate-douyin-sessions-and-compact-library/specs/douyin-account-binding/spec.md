## ADDED Requirements

### Requirement: One isolated Douyin binding per Zhicui user
The system SHALL assign each authenticated Zhicui user an independent opaque Douyin session scope and MUST NOT reuse another user's scope.

#### Scenario: First access creates a binding
- **WHEN** an authenticated user first opens the Douyin library
- **THEN** the system creates one binding record with a unique opaque session scope for that user

#### Scenario: Existing user returns
- **WHEN** the same user returns to the Douyin library
- **THEN** the system reuses only that user's existing session scope

#### Scenario: Two users use the library
- **WHEN** two authenticated users log in or synchronize concurrently
- **THEN** their Cookie files, QR state, jobs and library metadata remain isolated

### Requirement: Safe binding metadata
The system SHALL store binding status and lifecycle timestamps in the Zhicui database and MUST NOT store Douyin Cookie values, video binaries, Base64 video data or video file contents there.

#### Scenario: QR login succeeds
- **WHEN** a user's QR login completes
- **THEN** the binding record stores safe status, Cookie count and verification time without storing Cookie names or values

#### Scenario: Video library is synchronized
- **WHEN** a user synchronizes up to the allowed number of videos
- **THEN** the database may update binding and knowledge metadata but contains no video payload

### Requirement: Scoped task and media access
The system SHALL bind synchronization jobs and temporary media access to the current user's session scope.

#### Scenario: User reads own job
- **WHEN** a user requests a job started in their scope
- **THEN** the system returns that job status

#### Scenario: User guesses another job identifier
- **WHEN** a user requests a job belonging to another scope
- **THEN** the system returns not found or forbidden without exposing job details

#### Scenario: Temporary media URL is used
- **WHEN** a valid short-lived media URL is requested
- **THEN** the backend verifies a signature containing both the work ID and originating session scope before streaming

### Requirement: Mobile desktop-binding handoff
The system SHALL direct Android App and mobile-browser users to bind Douyin from a desktop browser with the same Zhicui account instead of starting a headless mobile QR task that may be blocked by an interactive security challenge.

#### Scenario: Unbound Android user starts binding
- **WHEN** an unbound user taps the Douyin binding action in the Android App
- **THEN** the App shows the desktop URL, same-account requirement and exact desktop steps without starting or cancelling a sidecar login task

#### Scenario: Unbound mobile-browser user starts binding
- **WHEN** an unbound user taps the Douyin binding action in a mobile browser
- **THEN** the page gives the same desktop-binding instruction and does not claim that the Douyin App can transfer its Cookie to the browser

#### Scenario: User finishes binding on desktop
- **WHEN** the user completes Chrome QR login on a desktop with the same Zhicui account and returns to the Android App
- **THEN** the App refreshes the scoped binding status and enables synchronization without requiring another QR flow

#### Scenario: User is already bound
- **WHEN** an Android user already has a valid scoped Douyin binding
- **THEN** the existing library and synchronization controls remain available normally

#### Scenario: Douyin requires an interactive security challenge
- **WHEN** the Douyin login page returns a CAPTCHA or security-verification intermediate page instead of a QR code
- **THEN** a visible desktop session tells the user to complete the challenge in the opened browser and continues QR discovery afterward

#### Scenario: Security challenge occurs in a headless session
- **WHEN** a CAPTCHA is detected where no interactive browser window can be shown
- **THEN** the login attempt stops promptly with an honest desktop-binding or retry instruction instead of showing an indefinite QR spinner

#### Scenario: User closes an active login panel
- **WHEN** the user closes the QR login panel before login completes
- **THEN** the system cancels only that user's browser task, clears the transient QR image and leaves all stored library metadata unchanged

### Requirement: Visible Chrome-directed desktop login
The system SHALL treat the visible installed Chrome window as the primary desktop login surface and SHALL NOT require a mirrored QR image in the Zhicui page before the user can continue.

#### Scenario: Desktop user starts Douyin binding
- **WHEN** a desktop user starts Douyin binding on a machine that can show a browser
- **THEN** the installed Chrome browser opens visibly in the foreground on the Douyin login page and remains open while the system waits for login

#### Scenario: QR mirroring is unavailable
- **WHEN** the QR code is visible in Chrome but cannot be extracted into the Zhicui page
- **THEN** the Zhicui page instructs the user to scan the QR code in the opened Chrome window and the login task continues instead of failing for a missing mirrored image

#### Scenario: Chrome shows a security challenge
- **WHEN** the visible Chrome window shows a security challenge before the QR code
- **THEN** the Zhicui page tells the user to complete the challenge in Chrome and then scan there while the same browser session remains active

#### Scenario: Production browser is not visible to the user
- **WHEN** the sidecar runs Chrome or Chromium on a remote server or virtual display
- **THEN** the login API does not claim that Chrome opened on the user's computer and the desktop page displays the mirrored QR image when it becomes available

#### Scenario: Remote production browser receives a security challenge
- **WHEN** the remote browser receives an interactive challenge that cannot be completed by the user
- **THEN** the task fails with an honest retry message instead of directing the user to an invisible Chrome window

### Requirement: Scoped logout and rebinding
The system SHALL clear only the current user's Douyin Cookie and QR state during logout or rebinding.

#### Scenario: One user logs out
- **WHEN** an authenticated user confirms logout
- **THEN** only that user's sidecar session becomes disconnected and other users remain connected

#### Scenario: One user rebinds
- **WHEN** an authenticated user confirms rebinding
- **THEN** only that user's current session is cleared before a new QR task starts in the same scope

### Requirement: Bounded QR recovery
The system SHALL recover from a stalled QR discovery without leaving the user on an indefinite spinner or surfacing a normal browser-cleanup race as a generic gateway failure.

#### Scenario: Production QR does not appear promptly
- **WHEN** a remote-capture login remains active without a QR image for the bounded discovery period
- **THEN** the client cancels that scoped browser, waits for cleanup and starts one fresh capture automatically

#### Scenario: Automatic recovery still has no QR
- **WHEN** the fresh capture also does not produce a QR image
- **THEN** the login panel stays open with an honest explanation and an explicit action to reopen Chrome locally or regenerate the production QR

#### Scenario: User retries while the previous browser is closing
- **WHEN** the same user starts login during scoped browser cleanup
- **THEN** the connector treats the request idempotently or returns a bounded retry state instead of a generic 502 response

### Requirement: Authoritative login completion reconciliation
The system SHALL recognize current authenticated Douyin session Cookie variants, persist only their safe count outside the sidecar and reconcile a completed desktop login when the same Zhicui account resumes on mobile.

#### Scenario: Current Douyin login returns a session Cookie variant
- **WHEN** QR confirmation produces any supported authenticated session Cookie such as `sessionid`, `sessionid_ss` or `sid_guard`
- **THEN** the sidecar saves the complete sanitized Cookie set in the scoped sidecar directory and marks the login complete without requiring an obsolete fixed Cookie pair

#### Scenario: Anonymous browser Cookies exist before confirmation
- **WHEN** the login page has only anonymous tracking or CSRF Cookies and no authenticated session Cookie
- **THEN** the sidecar keeps waiting and MUST NOT persist that set or report the user as bound

#### Scenario: Android App returns after desktop confirmation
- **WHEN** the same Zhicui account returns to the foreground while its desktop QR task is completing
- **THEN** the App performs a bounded series of scoped status checks, closes the binding guide and shows a success message as soon as the authoritative Cookie status is valid

#### Scenario: Login status is polled during completion
- **WHEN** a client polls an active or just-completed login task
- **THEN** the response includes safe completion and observed-Cookie counts without exposing Cookie names or values

### Requirement: Bounded concurrent login coordination
The system SHALL isolate concurrent logins by user scope, reuse a single in-flight login for duplicate requests in one scope and bound the number of browser workers running process-wide.

#### Scenario: Same user starts login from two clients
- **WHEN** two requests start login for the same user scope while one task is already active
- **THEN** both clients observe the same single-flight task and no second browser worker is created

#### Scenario: Different users start together below capacity
- **WHEN** different user scopes start login and browser capacity is available
- **THEN** their independent browser tasks may run concurrently and their QR, Cookie and cancellation state remain isolated

#### Scenario: Browser capacity is full
- **WHEN** another user starts login after the configured browser-worker limit is reached
- **THEN** the task enters an explicit queued state and starts automatically when capacity becomes available instead of failing with a gateway error

#### Scenario: One user cancels
- **WHEN** one scope cancels its queued or running login
- **THEN** no login task, Cookie or QR state belonging to another scope is changed
