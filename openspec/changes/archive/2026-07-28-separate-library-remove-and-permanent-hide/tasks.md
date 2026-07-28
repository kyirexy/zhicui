## 1. Data model and service

- [x] 1.1 Add temporary/permanent hide mode to the model and startup migration while preserving legacy rows as permanent
- [x] 1.2 Extend the hidden-item service with idempotent mode changes, time-bounded temporary clearing, counts, listing, and restore operations

## 2. Backend API and synchronization

- [x] 2.1 Make ordinary removal temporary by default and accept an explicit permanent mode
- [x] 2.2 Clear eligible temporary removals only after a later successful synchronization
- [x] 2.3 Return source/visible/hidden counts from the library list endpoint
- [x] 2.4 Add permanent-hidden list and bounded restore endpoints that work even when catalog metadata is unavailable

## 3. Library interface

- [x] 3.1 Update API types and client methods for hide modes, hidden counts, permanent-hidden listing, and restoration
- [x] 3.2 Update single and batch removal confirmations so temporary and permanent actions are visually and verbally distinct
- [x] 3.3 Add a responsive `已永久隐藏` manager with visible status markers and individual/batch restoration
- [x] 3.4 Update empty states and synchronization notices to explain hidden synchronized items accurately

## 4. Verification

- [x] 4.1 Validate OpenSpec artifacts and backend hide-mode behavior
- [x] 4.2 Run the production frontend build and inspect responsive interaction states
- [x] 4.3 Restart the local backend/frontend and verify health
