## MODIFIED Requirements

### Requirement: Accurate collection discovery feedback

The collection interface SHALL distinguish an unknown running total from a confirmed empty result, SHALL display only confirmed progress counts, SHALL distinguish account connectivity from per-source readability, and SHALL describe the bounded synchronization behavior in plain user-facing language without provider implementation terms.

#### Scenario: Collection total is not known yet

- **WHEN** a collection synchronization job is running and its reported total is missing or zero
- **THEN** the interface says it is reading the user's collection and does not claim that zero items were saved

#### Scenario: Collection progress is known

- **WHEN** a running collection synchronization job reports a positive total
- **THEN** the interface displays the confirmed successful count and total

#### Scenario: Collection synchronization succeeds

- **WHEN** a collection synchronization job completes with one or more successful items
- **THEN** the interface reports the actual synchronized count before loading the refreshed library

#### Scenario: Completed synchronization is empty

- **WHEN** a collection synchronization job completes successfully with zero items
- **THEN** the interface explains that no collection was read and suggests checking the selected source without claiming the account is disconnected

#### Scenario: Collection source is temporarily blocked

- **WHEN** the account remains connected but the connector reports `source_blocked` for collection
- **THEN** the interface labels only collection as temporarily unreadable, displays the suggested retry time, and keeps likes and own-post controls available

#### Scenario: Combined synchronization is partially successful

- **WHEN** a request includes collection and another source, and only collection is blocked
- **THEN** the interface preserves and reports successful source results without treating the whole account or job as disconnected

#### Scenario: User reads the collection explanation

- **WHEN** the collection source is selected
- **THEN** the interface explains the selected range, automatic transcript preparation, direct Q&A, on-demand knowledge cards, and no server-side video storage without naming ASR or a model provider
