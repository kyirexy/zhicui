## ADDED Requirements

### Requirement: Development session is explicitly gated
The backend MUST keep development session issuance disabled by default and SHALL issue a session only when the development bypass configuration is enabled and the request originates from a loopback client.

#### Scenario: Production default
- **WHEN** the development bypass configuration is absent or false
- **THEN** the development session endpoint refuses to issue a token

#### Scenario: Non-loopback request
- **WHEN** the development bypass configuration is enabled but the caller is not a loopback client
- **THEN** the endpoint refuses to issue a token

#### Scenario: Enabled local development
- **WHEN** the development bypass configuration is enabled and the caller is local
- **THEN** the endpoint creates or reuses the reserved active development administrator and returns a standard JWT session

### Requirement: Development client enters without credentials
The Next.js development client SHALL automatically obtain and persist a development session when no valid saved session exists, while production clients MUST retain the normal login flow.

#### Scenario: Open development login page
- **WHEN** the development client finishes obtaining a valid development session on the login page
- **THEN** it replaces the login route with the requested destination or home page without requiring form input

#### Scenario: Existing valid session
- **WHEN** the client already has a valid JWT
- **THEN** it restores that user without creating another development session

#### Scenario: Development session unavailable
- **WHEN** the development endpoint is disabled or unreachable
- **THEN** the client finishes loading and leaves the normal login interface available

### Requirement: No fixed credential in the client
The frontend source and browser bundle MUST NOT contain a hard-coded development JWT.

#### Scenario: Development build
- **WHEN** the frontend development bundle is generated
- **THEN** it obtains credentials from the gated backend endpoint instead of an embedded token literal
