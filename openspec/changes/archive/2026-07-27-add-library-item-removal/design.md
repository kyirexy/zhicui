## Context

The library catalog comes from the Douyin sidecar and is shared as synchronized metadata, while generated notes and plans are user-scoped in the application database. Deleting an item from the sidecar catalog would affect other application users and would be undone by a later synchronization. The removal preference therefore belongs in the application database and must be scoped to the authenticated user.

## Goals / Non-Goals

**Goals:**

- Persistently hide unwanted Douyin items for one Zhicui user across later synchronizations.
- Support idempotent single-item and bounded batch removal.
- Keep generated notes, cards, plans, Douyin favorites, and video files untouched.
- Make the semantics explicit in confirmation UI on desktop and mobile.

**Non-Goals:**

- Unfavoriting or deleting content on Douyin.
- Deleting previously generated knowledge or plans.
- Deleting sidecar catalog entries or media.
- Adding a restore/hidden-items management screen in this change.

## Decisions

### Store user-scoped tombstones in a dedicated table

Add a `library_hidden_items` table keyed by `(user_id, aweme_id)`. A dedicated table is queryable, portable across SQLite/PostgreSQL, idempotent through a unique constraint, and avoids placing an ever-growing JSON list in user settings. It stores only identifiers and timestamps.

### Filter after sidecar normalization and before note enrichment

Library list and detail routes will exclude IDs hidden by the current user. The sidecar remains the source for synchronized metadata, while the application controls each user's visible working set. Later synchronization may refresh sidecar metadata but cannot make a tombstoned item visible again.

### Keep removal non-destructive

Removal inserts tombstones only. Existing Notes, plans, transcripts, knowledge cards, Douyin favorites, and sidecar files are not deleted. This is safer than coupling removal to the existing knowledge-deletion action and matches the user's intent to curate the library view.

### Use one bounded batch endpoint for both UI paths

An authenticated endpoint accepts 1–50 unique Douyin work IDs. The single-card action sends one ID and the batch action sends the current selection. Reusing one contract keeps behavior and logging consistent with the existing 50-item selection ceiling.

### Require explicit confirmation

Both single and batch removal open the same accessible alert dialog, with copy that distinguishes Zhicui removal from Douyin unfavorite and knowledge deletion. Errors stay inside the dialog; successful removal immediately filters the local list and clears affected selections.

## Risks / Trade-offs

- **Hidden rows accumulate over time** → store only bounded string IDs and timestamps; add restore/cleanup management later if requested.
- **A user expects removal to delete generated knowledge** → confirmation text states that knowledge remains and the existing knowledge-delete action stays separate.
- **Duplicate IDs or repeated requests** → normalize and de-duplicate input, then use an idempotent lookup/insert transaction.
- **Direct detail URL for a hidden item** → return not found for the library workspace while leaving its generated Note accessible through the notes area.

## Migration Plan

1. Add the model to SQLAlchemy metadata; startup `create_all` creates the new table on SQLite and PostgreSQL.
2. Deploy filtering and removal APIs.
3. Deploy shared web/Capacitor UI.
4. Rollback can ignore the table; no destructive data migration is required.

## Open Questions

None. Restore management is intentionally deferred.
