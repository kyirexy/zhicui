## ADDED Requirements

### Requirement: Old client caches cannot strand the application
The client SHALL remove legacy application caches and Service Worker control, and MUST NOT cache HTML documents, API responses, or `/_next/` assets in a way that can outlive a deployment.

#### Scenario: Returning client has an old Service Worker
- **WHEN** a user opens the application while an older 知萃 Service Worker is still registered
- **THEN** the cleanup worker removes old caches, relinquishes control, and the next navigation uses current network assets

#### Scenario: Current static asset request
- **WHEN** the browser requests a current Next.js CSS or JavaScript chunk
- **THEN** the request is served from the network rather than a stale application cache

### Requirement: Authentication restoration must terminate
The client SHALL place a bounded timeout on authentication restoration and MUST leave the loading state when restoration succeeds, fails, or times out.

#### Scenario: Authentication endpoint hangs
- **WHEN** the authentication restoration request does not complete within the configured timeout
- **THEN** the application shows a recoverable authentication state instead of an indefinitely blank or loading page

#### Scenario: Development session can be retried
- **WHEN** local automatic development authentication times out
- **THEN** the user can retry the development session or continue to the login page

### Requirement: Application errors show recovery actions
The application SHALL render a branded error state with reload and navigation actions when a route-level or global runtime error occurs.

#### Scenario: Client runtime exception
- **WHEN** a route throws an uncaught client exception
- **THEN** the user sees a concise error explanation and a reload action rather than an empty document
