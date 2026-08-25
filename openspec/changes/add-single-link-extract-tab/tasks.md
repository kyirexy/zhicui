## 1. Navigation and routing

- [x] 1.1 Add the desktop-only single-link extraction destination, icon, active-state rules and authentication protection
- [x] 1.2 Route all homepage and workspace single-link actions to `/extract`

## 2. Extraction workspace

- [x] 2.1 Build the responsive `/extract` page with the existing extraction context, input, progress, error and result components
- [x] 2.2 Add desktop workspace metadata and accessible empty, loading and result states without adding a mobile bottom tab

## 3. Verification

- [x] 3.1 Add focused navigation tests for desktop ordering and mutually exclusive active states
- [x] 3.2 Run frontend tests, TypeScript checking, production build and strict OpenSpec validation

## 4. Visual refinement

- [x] 4.1 Replace the split card layout with one focused single-link workspace and a compact horizontal process rail
- [x] 4.2 Restyle the page-scoped input to remove nested glass borders, glow and excessive empty space while preserving paste, error and mobile behavior
- [x] 4.3 Run React/UI review, frontend regression checks, production build and desktop visual verification
- [x] 4.4 Remove the nested native input focus rectangle while retaining the rounded workspace focus indicator and verify the focused state
- [x] 4.5 Require an explicit button click or Enter submission after pasting a link instead of auto-starting extraction
