# Progress Log

Updated regularly throughout each session. One entry per day worked on.

---

## 19 March 2026

### Session summary
- Diagnosed and fixed background field round-trip bug: GET returns `library_node_read` with nested `file.s3_url`; POST expects `file_url_upload_object` with `{ file_url: string }`. Added `sanitizeBackground()` to handle the conversion.
- Confirmed document upload working end-to-end after the fix.
- Created `VAMOOS_API_SPEC.txt` (official OpenAPI spec v5.0.20251003) and `VAMOOS_FIELD_NOTES.md` (confirmed field mappings, gotchas, S3 upload flow) as permanent reference files.
- Updated `CLAUDE.md` session start checklist to reference both API files for Vamoos work.
- Updated `DESIGN_DOC.md` §7 current state to reflect confirmed working tools.
- Added three backlog items to `TODO.md`:
  1. Review GPX upload tool for correct fetch-then-merge on `pois`
  2. Review POI upload tool for fetch-then-merge
  3. Rework HTML document tool to support retrieve-edit-replace flow with versioned filenames

### Files changed
- `src/index.ts` — background sanitization fix
- `VAMOOS_API_SPEC.txt` — new
- `VAMOOS_FIELD_NOTES.md` — new
- `PROGRESS_LOG.md` — new
- `CLAUDE.md` — updated
- `DESIGN_DOC.md` — updated
- `TODO.md` — updated

---
