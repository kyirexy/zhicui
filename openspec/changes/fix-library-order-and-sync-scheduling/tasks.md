## 1. Custom automatic synchronization

- [x] 1.1 Normalize and persist bounded custom automatic-sync intervals
- [x] 1.2 Add preset and custom interval controls with responsive styling

## 2. Accurate source ordering

- [x] 2.1 Add an opt-in backend source-order refresh path to library listing
- [x] 2.2 Trigger source-order refresh when the user explicitly selects recent likes or collections

## 3. Sort menu interface

- [x] 3.1 Replace the native select with an accessible theme-aware ordering menu
- [x] 3.2 Add menu descriptions, selected state, dismissal behavior, and responsive styling

## 4. Verification

- [x] 4.1 Run frontend type/build and backend syntax checks
- [x] 4.2 Run strict OpenSpec validation and restart the desktop app

## 5. Source isolation and performance correction

- [x] 5.1 Normalize collection source identifiers and enable metadata-only synchronization
- [x] 5.2 Remove remote refresh from sort switching and eliminate progress-time full-library reloads
- [x] 5.3 Ignore stale library responses when users switch source or sort quickly
- [x] 5.4 Rebuild source snapshots, verify source counts/order/latency, and restart services

## 6. Metadata-first synchronization pipeline

- [x] 6.1 Separate blocking metadata synchronization from background transcript preparation
- [x] 6.2 Keep source navigation and the sync action responsive while transcript preparation runs
- [x] 6.3 Verify phase ordering, frontend build, and restarted desktop behavior

## 7. On-demand media compatibility and latency

- [x] 7.1 Preserve gallery image metadata and expose scoped image proxies
- [x] 7.2 Render gallery posts in the video knowledge workspace
- [x] 7.3 Cache resolved video targets and remove redundant cover lookups
- [x] 7.4 Verify gallery rendering data, repeated Range latency, build, and restarted services
