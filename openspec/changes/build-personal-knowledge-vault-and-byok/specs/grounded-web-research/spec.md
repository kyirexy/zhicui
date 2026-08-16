## MODIFIED Requirements

### Requirement: Question answering does not require a generated card
The system SHALL allow single-video and multi-source Q&A whenever a user-owned source has non-empty usable text, regardless of whether a knowledge card or AI summary has been initialized, and SHALL resolve the current user's AI provider before answering.

#### Scenario: Transcript-only video is selected
- **WHEN** the selected user-owned video has a complete transcript but no generated card
- **THEN** the Agent retrieves and answers from the complete transcript, reports that no AI summary was used, and preserves transcript evidence validation

#### Scenario: User has enabled a custom provider
- **WHEN** the current user asks a question and has a valid enabled custom provider configuration
- **THEN** the Agent uses that configuration only for this user's call and does not expose it to other users

#### Scenario: Provider returns reasoning without visible content
- **WHEN** the selected provider returns an empty visible answer with internal reasoning content
- **THEN** the Agent performs one controlled final-answer retry before reporting failure
