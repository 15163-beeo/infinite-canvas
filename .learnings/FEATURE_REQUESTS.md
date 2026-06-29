# Feature Requests

## [FEAT-20260626-001] aesthetic_mirror_history

**Logged**: 2026-06-26T16:52:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Requested Capability
Add history records to the 爆款复刻 page.

### User Context
Users need to reopen previous style-clone generation runs, including inputs, prompt, parameters, and generated images.

### Complexity Estimate
medium

### Suggested Implementation
Use a lightweight localforage store for `aesthetic_mirror_logs`, cap history to 50 records, save successful and failed generation attempts, and expose a drawer from the result toolbar for restore/delete/clear.

### Metadata
- Frequency: first_time
- Related Features: `web/src/app/(user)/aesthetic-mirror/page.tsx`

### Resolution
- **Resolved**: 2026-06-26T16:52:00+08:00
- **Notes**: Implemented local history drawer and automatic history persistence on generation.

---
