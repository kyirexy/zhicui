## ADDED Requirements

### Requirement: Agent turns use a verifiable orchestration pipeline
The system SHALL process each Agent turn through bounded question planning, complete server-side transcript scanning, evidence ranking, optional web research, answer synthesis, and citation verification.

#### Scenario: Answer from selected videos
- **WHEN** a user asks a question whose answer can be supported by the selected video transcripts
- **THEN** the service scans every transcript in the frozen snapshot, selects bounded evidence across relevant videos, synthesizes an answer, and retains only citations that can be matched to retrieved evidence

#### Scenario: Current external information is required
- **WHEN** the question requests a current link, current fact, or information absent from the selected transcripts and web research is available
- **THEN** the service performs a bounded external search, distinguishes web evidence from video evidence, and reports any search failure without discarding a supported video-based answer

#### Scenario: Model returns an invalid citation
- **WHEN** the generated answer cites a source that was not part of the verified evidence set
- **THEN** the service removes or marks that citation as unverified and does not claim the answer is fully grounded

### Requirement: Agent processing feedback is truthful
The workspace SHALL present concise execution stages derived from actual backend work and SHALL NOT expose hidden chain-of-thought or fabricate live steps.

#### Scenario: Completed answer includes execution trace
- **WHEN** the backend returns a completed Agent answer
- **THEN** the UI can disclose the real stages, scanned-video count, evidence count, and external-search status in user-facing language

#### Scenario: A recoverable stage fails
- **WHEN** optional web research or structured parsing fails but transcript evidence remains usable
- **THEN** the Agent returns the supported answer with a concise limitation and a retry affordance where appropriate

### Requirement: Agent interface uses a calm knowledge-work visual language
The Agent workspace SHALL use neutral content surfaces, one restrained mint accent, a non-anthropomorphic brand mark, and readable document-like answers on desktop and mobile.

#### Scenario: Empty Agent task
- **WHEN** a user opens a new Agent task
- **THEN** the workspace explains source selection and offers a small set of useful starting prompts without a cartoon robot or oversized decorative panel

#### Scenario: Long grounded answer
- **WHEN** an answer contains paragraphs, lists, citations, web sources, stages, and follow-up prompts
- **THEN** the answer remains the primary readable document while evidence and process details use separately labeled compact disclosures

#### Scenario: Narrow mobile viewport
- **WHEN** the Agent route is rendered at a 390 CSS pixel viewport
- **THEN** task history and source selection remain reachable through panels, messages do not overflow, and the composer stays above the safe area with a touch target of at least 44 CSS pixels

### Requirement: Agent identity is consistent and non-gimmicky
The system SHALL use one reusable Agent mark for headers, assistant messages, empty states, and desktop surfaces instead of generic robot-face iconography.

#### Scenario: Agent appears in multiple surfaces
- **WHEN** the user moves between the Agent list, conversation, settings, and desktop shell
- **THEN** the same accessible brand mark and name identify the Agent without decorative animation that distracts from the answer
