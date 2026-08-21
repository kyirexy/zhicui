# grounded-web-research Specification

## Purpose

Define safe, source-grounded web research behavior for single-video and multi-video Q&A.

## Requirements

### Requirement: Explicit research scope
The system SHALL let an authenticated user explicitly choose web-assisted research or video-only answering for single-video and multi-video questions, and video-only answering SHALL be the default when the client omits the setting.

#### Scenario: User explicitly enables automatic web research
- **WHEN** the user selects automatic web research
- **THEN** the agent evaluates whether the supplied transcripts and AI summaries are sufficient before deciding whether to search the web
- **AND** any web-derived claim is kept structurally separate from video evidence

#### Scenario: Video-only scope is selected or omitted
- **WHEN** the user selects video-only answering or submits no web scope
- **THEN** the agent MUST NOT make an external web request
- **AND** the answer uses only the frozen video sources and states any resulting limitation

### Requirement: Agent-planned web lookup
The system SHALL generate bounded search queries from the user's question, conversation context, video title, and retrieved transcript context when current or missing external information is required.

#### Scenario: User requests a repository link absent from the transcript
- **WHEN** the transcript mentions a GitHub project but does not contain its repository URL and the user requests that URL
- **THEN** the agent searches for likely repository matches and synthesizes an answer from verified search results

#### Scenario: Transcript already contains the answer
- **WHEN** the complete or retrieved transcript context directly supports the requested fact
- **THEN** the agent answers from the transcript without an unnecessary web lookup

### Requirement: Source provenance separation
The system MUST keep transcript evidence, AI-summary context, and external web sources visibly and structurally separate.

#### Scenario: Answer uses transcript and web findings
- **WHEN** an answer combines a video statement with current external information
- **THEN** the response identifies which claims came from the video and exposes clickable web sources separately

#### Scenario: Search result cannot be verified
- **WHEN** search results do not provide enough evidence to identify the requested entity confidently
- **THEN** the agent states the uncertainty and MUST NOT invent a URL, repository, author, statistic, or relationship

### Requirement: Safe bounded browsing
The web research tool SHALL enforce public HTTP(S) destinations, bounded timeouts, bounded response sizes, result limits, and untrusted-content handling.

#### Scenario: Search result points to a private network
- **WHEN** a result resolves to a loopback, link-local, private, or otherwise blocked network address
- **THEN** the fetch is rejected before the application retrieves page content

#### Scenario: A page contains instructions for the model
- **WHEN** retrieved web text attempts to alter the agent's instructions
- **THEN** the content is treated only as untrusted evidence and cannot override system or product rules

### Requirement: Research progress and citations UI
The Q&A workspace SHALL show the resolved research depth, active research scope, durable stage progress, distinct source coverage layers, external citations, retry behavior, and a composer that remains available at the bottom of the panel.

#### Scenario: Layered video research is running
- **WHEN** the agent is scanning, mapping, deep-reading, clustering, verifying, or repairing
- **THEN** the UI shows the current durable stage and its true counters without replacing the existing conversation
- **AND** metadata scanning is visually distinct from transcript mapping and deep reading

#### Scenario: Web research is explicitly enabled and running
- **WHEN** the user enabled web research and the agent is planning or searching
- **THEN** the UI shows concise state-specific web progress without implying that webpages are video evidence

#### Scenario: Research answer is complete
- **WHEN** a response includes validated video evidence or web sources
- **THEN** the UI groups evidence under its Claim and exposes readable video/source cards
- **AND** web cards retain title, domain, and external link separately from transcript evidence

#### Scenario: Mobile user asks a question
- **WHEN** the workspace is rendered on a mobile viewport
- **THEN** research controls remain touch-accessible, the answer remains readable, and the composer stays anchored below the scrollable conversation

### Requirement: Transcript-only question answering
The system SHALL allow single-video and multi-video Q&A whenever a user-owned source has a non-empty complete transcript, regardless of whether a knowledge card or AI summary has been initialized.

#### Scenario: Single video has no AI summary
- **WHEN** the user asks a question about a transcript-ready video whose AI initialization is incomplete
- **THEN** the Agent retrieves and answers from the complete transcript, reports that no AI summary was used, and preserves transcript evidence validation

#### Scenario: Library contains mixed initialization states
- **WHEN** a multi-video question includes transcript-ready Notes with and without initialized AI summaries
- **THEN** all selected transcripts participate in retrieval while only initialized summaries contribute summary context

#### Scenario: Transcript does not contain the answer
- **WHEN** a transcript-only source lacks the requested fact
- **THEN** the existing automatic/video-only research policy applies without requiring card initialization and without inventing an answer
