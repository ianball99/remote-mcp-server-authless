# Project Todo List

> Reviewed at session start. Updated at session end.
> Format: `- [ ]` = open, `- [x]` = done

---

## In Progress

_Nothing currently in progress._

## Priority

- [ ] **Priority 1 — Investigate `create_itinerary` field options** — Check whether person/traveller fields can be passed at creation time to collapse the two-step `create_itinerary` + `add_person_to_itinerary` flow into one call
- [ ] **Priority 2 — Connect Hotels API** — Integrate a hotels API to allow hotel search and booking within itineraries

## Investigate

- [ ] **29 Mar 2026 — Vamoos API: traveller/email filter on list_itineraries** — The `GET /itinerary` endpoint has a generic `f` (filter) parameter but no documented traveller email filter. Need to ask Vamoos developers whether filtering itineraries by traveller email is supported (either via the `f` param or a separate endpoint). If available, this would replace the Netlify Blobs approach entirely with a single API call.
- [ ] **25 Mar 2026 — Hyphens / special characters in passcodes** — `ib2303-1` fails to load. Check whether hyphens and other non-alphanumeric characters are permitted in Vamoos passcodes, and whether the MCP tools / API calls need to encode or sanitise them.
- [ ] **22 Mar 2026 — fetch error / token rate limit on new trip** — Sequence: listed itineraries, then asked chatbot to create a 'new trip' → got a 'fetch error'. Retried → got 'token rate limit exceeded'. Unclear whether root cause is (a) chatbot hitting Anthropic rate limit mid-request, (b) Vamoos API token exhausted, or (c) a transient network/worker error masking the real cause. Reproduce and check Cloudflare Worker logs + chatbot error handling.
- [ ] **22 Mar 2026 — HTTP 400 when adding POI to trip with existing GPX track location** — Fixed 22 Mar 2026 via `claude/fix-itinerary-merge-ZBL1t`. Needs re-test to confirm.

## Backlog

- [ ] **Investigate why `field3` (Name/Location) is absent from GET itinerary response**
- [ ] **Clarify locations tab vs general tab location field**
- [ ] Revisit `upload_gpx_and_attach_to_itinerary` — verify fetch-then-merge is correct (pois array must be merged, not overwritten)
- [ ] Check GPX track and POI visibility settings — confirm `is_default_on`, `poi_range`, and `type` values with Alisdair
- [ ] Rework `upload_created_html_itinerary_document` to support a retrieve-edit-replace flow

## Completed

- [x] Set up remote MCP server on Cloudflare Workers
- [x] Implement create_itinerary tool
- [x] Implement fetch-then-merge pattern for itinerary updates (confirmed 19 March 2026)
- [x] Document deployment flow in CLAUDE.md (Cloudflare + Netlify)
- [x] Fix background field round-trip mapping
- [x] Create VAMOOS_API_SPEC.txt and VAMOOS_FIELD_NOTES.md reference docs
- [x] Confirm document upload working end-to-end (19 March 2026)
- [x] Build `add_person_to_itinerary` tool — fetch-then-merge, deduplicates by email (25 March 2026)
- [x] Build `add_flight_to_itinerary` and `add_location_to_itinerary` tools (22 March 2026)
- [x] **Person name uses email address** — `CreateTripPage` now passes `name: email` instead of hardcoded `"mcp chat creator"` (29 March 2026)
- [x] **Summary tab live preview + Save + load on page load** — HTML doc shows immediately when chatbot uploads; Save button persists with standard name `Trip Summary-{title}`; page load scans `documents.all` and fetches via `fetch-document` proxy using `file.https_url` (29 March 2026)
- [x] **Per-user trip filtering via Netlify Blobs** — `trip-index.js` function reads/writes email→trips index; `HomePage` reads from it instead of calling `list_itineraries`; `CreateTripPage` and `TripPage` write to it on trip create and person add (29 March 2026)
- [x] **HTML itinerary transparent background + white text + Roboto font** — `SYSTEM_PROMPT.md` updated with styling guidance (1 April 2026)
- [x] **Email OTP verification per browser** — 6-digit code via Resend (`noreply@send.infoalchemy.co.uk`), 5-min expiry, 7-day browser verification window. `send-otp.js`, `verify-otp.js`, `check-verification.js` functions added. `AuthGuard` wraps all protected routes. Verified sending domain `send.infoalchemy.co.uk` added to Resend (1 April 2026)
