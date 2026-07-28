## ADDED Requirements

### Requirement: AI processing requires an explicit user action
The library SHALL synchronize source metadata without starting ASR or LLM work, and SHALL create an extraction job only after the user explicitly selects eligible videos and activates the generate-transcript-and-card action.

#### Scenario: User synchronizes favorites
- **WHEN** the user synchronizes liked, collected, or posted videos
- **THEN** the video list and metadata are updated without starting transcript extraction, classification, card generation, or plan generation

#### Scenario: User explicitly processes selected videos
- **WHEN** the user selects one or more eligible videos and activates “生成文案与知识卡”
- **THEN** the selected videos are submitted as one concurrent extraction job and per-item progress is shown

#### Scenario: Synchronization completes
- **WHEN** a metadata synchronization job finishes successfully
- **THEN** no videos are automatically selected and the interface instructs the user to choose which videos need AI processing

#### Scenario: User opens AI Q&A before processing
- **WHEN** synchronized videos do not yet have saved transcripts
- **THEN** the Q&A interface does not silently process them and clearly directs the user to generate content first

## REMOVED Requirements

### Requirement: Processing count follows the sync range by default
**Reason**: Synchronizing a source list must not automatically incur ASR and LLM processing for every synchronized item.

**Migration**: Remove automatic processing controls from the sync panel and use the existing selected-video batch action for all future transcript and card generation.
