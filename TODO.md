# Project Todo List

> Reviewed at session start. Updated at session end.
> Format: `- [ ]` = open, `- [x]` = done

---

## In Progress

- [ ] (add items here)

## Backlog

- [ ] Revisit `upload_gpx_and_attach_to_itinerary` — verify it uses fetch-then-merge correctly (pois array must be merged, not overwritten)
- [ ] Revisit `upload_poi` tool — check it works correctly with fetch-then-merge pattern
- [ ] Check GPX track and POI visibility settings — confirm `is_default_on`, `poi_range`, and `type` values are correct for display in Vamoos app. Check with Alisdair.
- [ ] Build `add_flight_to_itinerary` tool — allow Claude to add a flight to an itinerary via Vamoos API
- [ ] Rework `upload_created_html_itinerary_document` to support a retrieve-edit-replace flow:
  - Retrieve current HTML document from itinerary and show user
  - Allow user to request changes via chatbot
  - Upload new version with version number appended to filename (e.g. `itinerary_v2.html`)
  - Replace old document in the itinerary's travel docs list

## Completed

- [x] Set up remote MCP server on Cloudflare Workers
- [x] Implement create_itinerary tool
- [x] Implement fetch-then-merge pattern for itinerary updates (confirmed 19 March 2026)
- [x] Document deployment flow in CLAUDE.md (Cloudflare + Netlify)
- [x] Fix background field round-trip mapping (GET returns library_node_read with file.s3_url; POST expects file_url_upload_object with file_url)
- [x] Create VAMOOS_API_SPEC.txt and VAMOOS_FIELD_NOTES.md reference docs
- [x] Confirm document upload working end-to-end (19 March 2026)
