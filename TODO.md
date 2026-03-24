# Project Todo List

> Reviewed at session start. Updated at session end.
> Format: `- [ ]` = open, `- [x]` = done

---

## In Progress

- [ ] (add items here)

## Priority

- [ ] **Priority 1 — UI Design** — Design and implement UI improvements for the chatbot interface
- [ ] **Priority 2 — Email ID for person** — Add ability to capture / store / use a person's email ID within the system
- [ ] **Priority 3 — Connect Hotels API** — Integrate a hotels API to allow hotel search and booking within itineraries

## Investigate

- [ ] **22 Mar 2026 — fetch error / token rate limit on new trip** — Sequence: listed itineraries, then asked chatbot to create a 'new trip' → got a 'fetch error'. Retried → got 'token rate limit exceeded'. Unclear whether root cause is (a) chatbot hitting Anthropic rate limit mid-request, (b) Vamoos API token exhausted, or (c) a transient network/worker error masking the real cause. Reproduce and check Cloudflare Worker logs + chatbot error handling.
- [ ] **22 Mar 2026 — HTTP 400 when adding POI to trip with existing GPX track location** — `add_poi_and_attach_to_itinerary` failed at step 3/3 with `openapi-validation` errors on `locations[0]`: fields like `id`, `operator_id`, `created_at`, `itinerary_id`, `loc_position`, `on_weather`, `on_maps` rejected as additional properties, and `$source` required but missing. Root cause: existing locations from GET response were spread raw into the update payload, bypassing the `pickWritable` stripping. **Fixed 22 Mar 2026** — same bug was in all three POI/GPX handlers; fixed by calling `pickWritable` once and reading `locations` from the result before appending the new location. Deployed via `claude/fix-itinerary-merge-ZBL1t`. Needs re-test to confirm.

## Backlog

- [ ] **Investigate why `field3` (Name/Location) is absent from GET itinerary response** — The General tab UI field "Name / Location" maps to `field3` in the POST payload, but `field3` does not appear in GET itinerary responses (even when set). Possible causes: (a) field is write-only or not returned by this endpoint, (b) field is only exposed on a different GET endpoint, (c) value is stored elsewhere under a different key. Check raw GET response and Vamoos API spec for `field3` behaviour.
- [ ] **Clarify locations tab vs general tab location field** — Two distinct concepts are easily confused: (1) **Locations tab** (`locations[]` array in API) — structured entries with lat/long, name, type etc., displayed in the Vamoos app locations tab; (2) **General tab location text** — a plain-text field on the itinerary header, believed to be `field2` or `field3` in the API. Need to confirm exact API field name(s) for the general tab location/name text field and document clearly in VAMOOS_FIELD_NOTES.md so tools don't conflate the two.
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
