# Progress Log

Updated regularly throughout each session. One entry per day worked on.

---

## 1 April 2026 (session 2)

### Email OTP verification per browser — `claude-code-chatbot-v1`

Replaced the fake skip-through OTP stub in LoginPage with real server-side email verification. The full flow: user enters email → 6-digit code sent by email → user enters code → browser+email marked as verified for 7 days.

**Three new Netlify functions:**
- `send-otp.js` — generates a 6-digit code, stores in Netlify Blobs `otp-store` with 5-minute expiry, sends via Resend API. Rate-limited: rejects with 429 if a valid code already exists for that email.
- `verify-otp.js` — validates submitted code server-side, deletes it on success, writes `{ verifiedAt }` to Netlify Blobs `browser-verifications` keyed by `email:browserId`.
- `check-verification.js` — looks up the `browser-verifications` record for a given email+browserId pair; returns `{ verified: true }` if within 7-day window.

**`AuthGuard` component (`App.jsx`):** Wraps all protected routes (`/home`, `/trip/:refCode`, `/create-trip`). Calls `check-verification` on every route load; redirects to `/` if not verified or expired.

**Browser UUID:** `crypto.randomUUID()` generated on first visit, stored in localStorage as `vamoos_browser_id`. Each new browser or cleared storage gets a fresh UUID.

**Resend API:** Initially used `onboarding@resend.dev` — discovered this sender only delivers to the Resend account owner's email. Fixed by verifying domain `send.infoalchemy.co.uk`; OTP emails now sent from `noreply@send.infoalchemy.co.uk`.

**Bug fixed — mount-time redirect bypass:** Initial implementation included a `useEffect` on LoginPage mount that auto-redirected to `/home` if a verified email was still in localStorage. After sign-out this fired before localStorage was fully cleared, bypassing the email entry step. Fixed by removing the mount-time check. Verification is now only checked on email submit — the email field is always shown after sign-out. If the entered email is already verified for that browser, the OTP is skipped and the user goes straight to `/home`.

**Bug fixed — 429 dead-end:** Going back to step 1 while a valid code existed then hitting Next returned 429, leaving the user stuck. Fixed by treating 429 as a soft signal on the frontend — advances to step 2 so the user can enter the code they already have.

**README updated to v2.3:** Added Design Decisions section documenting all key choices and reasoning.

---

## 1 April 2026

### HTML itinerary styling — `SYSTEM_PROMPT.md`

Three successive styling improvements to the instructions Claude follows when generating HTML itinerary documents:

1. **Roboto font** — added `<link>` to Google Fonts (Roboto 400/700) so generated documents use a clean sans-serif typeface instead of the browser default.
2. **White text on dark backgrounds** — updated colour guidance so text sections on dark-coloured backgrounds use white text. The Vamoos app displays documents overlaid on the trip background image, so dark text on a semi-transparent background can be hard to read.
3. **Transparent document background** — set `background: transparent` on the outer body/container so the Vamoos app background image shows through behind the document, rather than a solid white or coloured fill blocking it.

All three changes are prompt-only (`SYSTEM_PROMPT.md`); no server code changes.

---

## 31 March 2026

### Durable Objects migration fix — `wrangler.jsonc`

Fixed a deploy error (Cloudflare error 10074) caused by a rename migration referencing `MyMCP`, a class name that was never deployed. The `wrangler.jsonc` had two migrations:
- v1: `new_sqlite_classes` for `VamoosMCP`
- v2: rename `MyMCP → VamoosMCP`

The v2 migration was left over from an earlier draft and was invalid because `MyMCP` never existed as a live class. Collapsed to a single `new_sqlite_classes` entry at tag v1 for `VamoosMCP`.

---

## 30 March 2026

### TODO update

Added task: set HTML itinerary summary `transparent: false` (later addressed with the 1 April styling commits above).

---

## 29 March 2026

### Per-user trip filtering design decision — `DESIGN_DOC.md`

Documented and decided the approach for showing only the logged-in user's trips on the HomePage. Four options evaluated (Vamoos API filter, Netlify Blobs, localStorage, full scan). Selected Option B (Netlify Blobs) pending Vamoos developer confirmation of a server-side traveller email filter.

Implementation in `claude-code-chatbot-v1`:
- New `netlify/functions/trip-index.js` — Netlify Blobs key-value store keyed by lowercase email
- `@netlify/blobs` added to `package.json`
- `CreateTripPage.jsx` — writes to blob store after `create_itinerary`
- `ChatPanel.jsx` / `TripPage.jsx` — fire `onPersonAdded` callback to write blob after `add_person_to_itinerary`
- `HomePage.jsx` — reads blob store keyed by logged-in email instead of calling `list_itineraries`

Added §5.12 to `DESIGN_DOC.md` documenting the decision and implementation.

---

## 28 March 2026

### v0 UI integration — `claude-code-chatbot-v1`

Rebuilt the chatbot UI from a single-page inline-CSS React app into a full multi-page application using the v0-chatbot-app-v2 design (dark gray + orange Tailwind CSS theme, shadcn-style layout).

**Architecture changes:**
- Added Tailwind CSS 4, React Router, lucide-react to Vite/React app
- Extracted the full agentic loop from monolithic `App.jsx` into reusable `ChatPanel` component, re-skinned in v0 orange/dark-gray theme
- New pages: Login (captures email → localStorage), Verify (skip-through), Home, TripPage (view/update), CreateTripPage (new trip form)

**Home page — live trip list:**
- Fetches `list_itineraries` via mcp-tool proxy on load
- Displays all trips with title and start date
- "Add new trip" button navigates to CreateTripPage

**CreateTripPage — new trip form:**
- Captures title, start date (flexible parsing: d/m/yy, YYYY-MM-DD, etc.), end date
- Auto-generates reference code as `trip` + `YYYYMMDDHHmmss` — internal, not shown to user
- Two sequential MCP calls on submit (both critical):
  1. `create_itinerary` — creates the trip in Vamoos
  2. `add_person_to_itinerary` — adds `{ name: "mcp chat creator", email: <login email> }` to the trip
- Navigates to TripPage on success, passing title + start date via router state for immediate heading

**TripPage (shared for view and update):**
- Split-pane layout with draggable divider
- Top pane: two tabs — Details (shows `get_itinerary` result) and Summary (shows draft HTML itinerary document in iframe)
- Bottom pane: ChatPanel with full agentic loop
- Details tab auto-refreshes after any mutating tool call (add flight, person, location, etc.)
- Summary tab populated when `upload_created_html_itinerary_document` fires (HTML captured before PDF conversion)
- Heading shows title + start date immediately (from router state) without waiting for `get_itinerary`

**End-to-end test — confirmed working ✅**
- New trip created successfully via CreateTripPage form
- `add_person_to_itinerary` call succeeded — person with login email added as "mcp chat creator"
- **IB received a push notification on phone** immediately after trip creation
- **Trip appeared in the Vamoos mobile app** — confirmed visible and correct

**Todo added:**
- Investigate `create_itinerary` field options — check if person or other fields can be included in the initial create call to simplify the flow

### UI fixes and auto-background image — `claude-code-chatbot-v1` (session 2)

**Trip list parsing fix:**
- Home page was showing raw JSON instead of a trip list
- Two bugs fixed: Vamoos uses `field1` (not `title`) for the trip name, and `items` (not `results`) for the array key in the `list_itineraries` response

**Claude-formatted trip details:**
- Details tab was showing raw JSON from `get_itinerary`
- New `netlify/functions/format-trip.js` — lightweight single call to `claude-haiku-4-5-20251001` (no tools, max 1024 tokens)
- System prompt instructs Claude to produce clean plain-text with ALL CAPS section headings, skipping internal fields, including all meaningful content
- Future-proof: any new Vamoos fields will automatically appear without code changes
- TripPage updated to call `format-trip` after `get_itinerary` on load and after every mutating tool call

**Auto background image on trip creation:**
- Confirmed that trips without a background image fail to download to the mobile app
- New `netlify/functions/generate-trip-image.js`:
  1. Calls Claude Haiku to extract 2–3 destination keywords from the trip title (e.g. "Morocco Adventure" → "morocco desert landscape")
  2. Queries Pixabay API (`PIXABAY_API_KEY` env var) for a horizontal travel photo matching those keywords
  3. Downloads the image and returns as base64 + content type
- `CreateTripPage.jsx` updated:
  - Parses `vamoos_id` from the `create_itinerary` response (required by `upload_background_image`)
  - Runs `add_person_to_itinerary` and image generation in parallel (`Promise.allSettled`)
  - Calls `upload_background_image` MCP tool with the Pixabay image
  - Background upload is non-fatal — trip creation still succeeds if the image step fails
  - Button shows step-by-step progress: "Creating trip…" → "Adding details…" → "Uploading background…" → "Opening trip…"

---

## 25 March 2026

### `add_person_to_itinerary` tool
- Investigated travellers API shape: confirmed GET returns `id`, `tag`, `itinerary_id`, `created_at`, `updated_at` as read-only alongside writable `name`, `email`, `details`, `is_active`.
- Added `"travellers"` to `WRITABLE_ITINERARY_FIELDS`.
- Added `travellers` branch to `pickWritable()` — strips read-only per-entry fields, preserves `name`, `email`, `details`, `is_active`.
- Registered `add_person_to_itinerary` MCP tool: 2-step fetch-then-merge, deduplicates by email (case-insensitive), appends `{ name, email }` for new travellers.
- Chatbot (`claude-code-chatbot-v1`) updated: tool definition added to `TOOLS` array, `PERSON:` bullet added to system prompt.
- Confirmed working end-to-end.
- All docs updated: `DESIGN_DOC.md`, `VAMOOS_FIELD_NOTES.md` (new §3e), `TODO.md`, `PROGRESS_LOG.md`.
- Investigated passcode special characters: `ib2303-1` fails to load — added to Investigate in TODO.

---

## 22 March 2026

### `add_flight_to_itinerary` tool
- Added MCP tool: look up a flight via `GET /flight/lookup/{carrier}/{number}/{dep}/{arr}/{date}`, then attach to trip via `flight_ids` field in itinerary POST.
- `pickWritable()` updated to derive `flight_ids` from the read-only `flights[]` array in the GET response, so existing flights are preserved when any other itinerary update is made.
- Chatbot updated with matching tool definition and system prompt guidance.
- Field notes updated: §3c documents the `flights` (read-only) vs `flight_ids` (writable) distinction.

### `add_location_to_itinerary` tool
- Added MCP tool: add a standalone location to a trip (no POI).
- Clarified that POI tools already auto-add a matching location alongside each POI, so this tool is only needed for locations without a POI (e.g. a city stopover to pull in nearby global Vamoos POIs).
- Tool description and chatbot system prompt updated to reflect this.
- Field notes §3a updated with auto-add behaviour note.

---

## 20 March 2026

### `pickWritable()` sanitisation fixes
- Fixed `locations[]` round-trip: GET returns extra fields (`id`, `itinerary_id`, `country`, `country_iso`, `timezone`, `created_at`, `updated_at`) that cause 422 errors if re-sent. Strip to `{ name, latitude, longitude }` only.
- Fixed `notifications[]` round-trip: same issue. Strip to `{ type, content, url, is_active }`.
- Fixed `documents.all`: GET response includes computed `.all` array alongside `.travel`/`.destination`. Must be excluded from POST payload. Fixed in `getExistingDocuments()`.
- Transient HTTP 408 observed on one date-change update (ibtest2003-4) — confirmed not a code bug; was a network timeout unrelated to the sanitisation fixes.

### `add_poi_and_attach_to_itinerary` tool
- Added new MCP tool: create a named map pin (`type: "poi"`) and attach to itinerary using same fetch-then-merge pattern as GPX tool.
- Also appends a `locations` entry for the pin coordinates.
- Added matching tool definition and system prompt guidance to chatbot (`claude-code-chatbot-v1`).

### Documentation checkpoint — 20 March 2026
- `DESIGN_DOC.md` updated: tool table, §5.2 expanded for `type: "poi"` vs `type: "track"`, §7 current state refreshed, §9 cheat sheet updated with named pin pattern.
- `VAMOOS_FIELD_NOTES.md` updated: §3 `documents.all` warning, new §3a locations shape, new §3b notifications shape, §5 POI type table.
- `TODO.md` updated: added GPX/POI visibility check item (check with Alisdair) and `add_flight_to_itinerary` backlog item.
- **Docs checkpoint noted here — further updates to DESIGN_DOC and VAMOOS_FIELD_NOTES will follow after additional work this session.**

---

## 19 March 2026 (session 2 — housekeeping)

- Rebuilt PROGRESS_LOG.md with full day-by-day history from git log (10–19 March)
- Fixed CLAUDE.md: replaced all `main` references with `master` for this repo
- Added session end checklist steps: merge `claude/` to `master`, merge chatbot `claude/` to `main`, delete merged branches
- Deleted stale `main` branch (superseded by `master`)
- Deleted merged `claude/` branches from both repos
- Confirmed chatbot `claude/organize-sessions-projects-4F01z` was already fully merged

---

## 19 March 2026

### Fetch-then-merge pattern
- Identified that Vamoos itinerary POST is a full overwrite — any omitted field is deleted
- Implemented fetch-then-merge on all itinerary update paths (`upload_background_image`, `upload_document`, `upload_gpx_and_attach_to_itinerary`)
- Discovered that spreading the raw GET response breaks POST (read-only fields rejected). Refactored to `pickWritable()` whitelist approach
- Added deduplication logic: `mergePois()` by id, `mergeTravelDocs()` by file_url, locations appended

### Background field bug
- Diagnosed background round-trip bug: GET returns `library_node_read` with nested `file.s3_url`; POST expects `{ file_url: string }`. These are completely different shapes
- Added `sanitizeBackground()` to extract `file.s3_url` and convert to correct POST format
- Confirmed document upload working end-to-end after fix

### Documentation and project hygiene
- Created `CLAUDE.md` with session start/end checklists and Vamoos API notes
- Created `TODO.md`
- Created `VAMOOS_API_SPEC.txt` (official OpenAPI spec v5.0.20251003)
- Created `VAMOOS_FIELD_NOTES.md` (confirmed GET/POST field mappings, S3 flow, read-only fields)
- Created `PROGRESS_LOG.md` (this file)
- Updated `DESIGN_DOC.md` §7 current state
- Documented Cloudflare auto-deploy behaviour (master + claude/** branches)
- Clarified Netlify deploys from main only; Claude pushes to main on user approval
- Clarified that 403 on master push = PAT not configured, not a sandbox restriction

---

## 18 March 2026

### GPX track upload
- Fixed GPX upload: replaced broken `/poi/gpx` endpoint with `/poi` JSON approach
- Parse GPX XML server-side to extract `<trkpt>` waypoints, POST as `{ type: "track", meta: { waypoints: [...] } }`
- Added a location pin at the GPX track start point when attaching to itinerary
- Added detailed step-by-step logging to GPX tool for easier debugging
- Wrote `DESIGN_DOC.md` covering architecture, decisions, and blind alleys up to this date

---

## 17 March 2026

### GPX upload debugging
- Added `AbortSignal.timeout` to GPX Vamoos fetch calls for clearer timeout errors
- Tried multipart/form-data for GPX upload — failed
- Tried raw `application/gpx+xml` body — also failed
- Added minimal `test.gpx` (3 points) for API testing
- Renamed `upload_gpx_track` → `upload_gpx_and_attach_to_itinerary`

---

## 16 March 2026

### Tool description fix
- Fixed `upload_document` description to reference the correct tool name

---

## 15 March 2026

### HTML document tool
- Added `upload_created_html_itinerary_document` — AI writes HTML directly, uploaded as `.html` file
- Retired markdown→PDF approach as legacy (kept in codebase as `legacy_upload_created_itinerary_document`)

---

## 13 March 2026

### Document generation — multiple iterations
- Replaced `pdf-lib` with Cloudflare Puppeteer for HTML→PDF conversion (pdf-lib crashed on Unicode)
- Added system prompt (`SYSTEM_PROMPT.md`) for Vamoos travel interview assistant
- Tried markdown as document format with server-side converter — incomplete, inconsistent
- Switched to AI writing HTML directly
- Added `upload_created_itinerary_document` tool with markdown input (later replaced by HTML version)
- Fixed model routing: tool descriptions updated so AI uses the right tool for AI-generated vs user-supplied content
- Consolidated `generate_and_upload_pdf` into `upload_document` as mode 1
- Fixed `list_itineraries`: removed operator code from URL path (correct endpoint is `GET /itinerary`, operator in header only)
- Fixed GitHub Actions deploy trigger: was watching `main`, changed to `master` + added `claude/**`

---

## 12 March 2026

### Core upload tools
- Added `upload_background_image` and `upload_document` MCP tools
- Added `/upload` HTTP endpoint accepting `multipart/form-data` binary blobs
- Added `list_itineraries` and `get_itinerary` tools
- Added `generate_and_upload_pdf` tool (server-side PDF generation)
- Fixed non-JSON (HTML) error responses from API calls with `safeJson()`
- Declared `VAMOOS_API_TOKEN` as Cloudflare secret

---

## 11 March 2026

### Initial build
- Built Vamoos itinerary MCP server for Cloudflare Workers (`create_itinerary`, `update_itinerary`)
- Added GitHub Actions deploy workflow

---

## 10 March 2026

- Source repo imported / project started
