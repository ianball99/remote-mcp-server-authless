# Vamoos MCP Server — Design Document
**Status:** Working as of 18 March 2026
**Author:** Built in collaboration with Claude Code
**Repo:** `ianball99/remote-mcp-server-authless`

---

## 1. What We Built

A **remote MCP (Model Context Protocol) server** deployed on Cloudflare Workers that allows an AI assistant (Claude) to create and manage travel itineraries in the **Vamoos** travel app platform — all via natural language conversation.

The system lets you have a conversation with Claude, describe a trip, and have it:
- Create the trip in Vamoos
- Write a formatted day-by-day HTML itinerary document and attach it
- Upload background images
- Upload GPX walking/cycling/driving tracks so they appear on the map in the app
- List and retrieve existing itineraries

The MCP server is the bridge between Claude (the AI) and the Vamoos REST API.

---

## 2. Architecture Overview

```
User (in Claude.ai or Claude Desktop)
        │
        │  natural language conversation
        ▼
    Claude AI  ←──── SYSTEM_PROMPT.md (interview instructions)
        │
        │  MCP tool calls (JSON)
        ▼
  Cloudflare Worker  (vamoos-mcp-server)
  ┌─────────────────────────────────────────────────┐
  │  POST /mcp  ──►  VamoosMCP (McpAgent)           │
  │                  8 MCP tools defined here        │
  │                                                  │
  │  POST /upload ──► handleUpload()                 │
  │                   (file upload endpoint)         │
  └─────────────────────────────────────────────────┘
        │
        │  REST API calls
        ▼
  Vamoos API (live.vamoos.com/v3)
        │
        ├─► /itinerary/{operator}/{ref}   (create/update trips)
        ├─► /poi                          (create map POIs/tracks)
        └─► /file/upload_url             (get S3 pre-signed URLs)
              │
              ▼
          AWS S3  (file storage for images, HTML docs)
```

### Key technology choices:
- **Cloudflare Workers** — serverless edge deployment, auto-deploys from GitHub
- **MCP protocol** — standard interface so Claude can call tools reliably
- **`agents` npm package** — `McpAgent` base class handles MCP protocol plumbing
- **Zod** — runtime schema validation on all tool inputs
- **Cloudflare Puppeteer** — browser instance for HTML→PDF conversion (see legacy section)
- **Durable Objects** — required by `McpAgent` for stateful MCP session management

---

## 3. The Two Entry Points

### `/mcp` — The MCP Server
This is what Claude connects to. It speaks the MCP protocol and exposes 8 tools.

### `/upload` — HTTP File Upload Endpoint
A separate REST endpoint accepting `multipart/form-data`. Handles three upload types:
- `background` — upload an image to S3, attach as trip background
- `document` — upload a file to S3, attach as a travel document
- `gpx` — parse the GPX XML, create a Vamoos POI (no S3 needed), attach to trip

This endpoint exists as a fallback/alternative path and supports CORS for browser clients.

---

## 4. The MCP Tools

| Tool | Purpose |
|------|---------|
| `create_itinerary` | Create a new trip in Vamoos |
| `update_itinerary` | Update an existing trip (requires `vamoos_id`) |
| `list_itineraries` | List all trips (paginated) |
| `get_itinerary` | Get full details of one trip by reference code |
| `upload_background_image` | Upload image to S3, attach as trip background |
| `upload_created_html_itinerary_document` | **Primary doc tool** — write HTML, upload as .html file |
| `upload_gpx_and_attach_to_itinerary` | Parse GPX, create POI with `type: "track"`, attach to trip |
| `add_poi_and_attach_to_itinerary` | Create a named map pin (`type: "poi"`) and attach to trip; also auto-adds a location |
| `create_and_add_poi` | Look up or create a Vamoos global POI, then attach to trip; also auto-adds a location |
| `add_flight_to_itinerary` | Look up flight via carrier/number/airports/date, attach via `flight_ids` |
| `add_location_to_itinerary` | Add a standalone location (no POI) — only needed when no POI is being added |
| `add_person_to_itinerary` | Add a traveller (name + email) to an itinerary; preserves existing travellers; deduplicates by email |
| `upload_document` | Upload user-supplied file (base64) or HTML→PDF conversion |
| `legacy_upload_created_itinerary_document` | **Deprecated** — markdown→PDF via Puppeteer, kept for reference |

---

## 5. Key Design Decisions

### 5.1 HTML Files, Not PDFs, for Documents
**Decision:** The AI writes documents as HTML and they are stored/served as `.html` files.

**Why:** We spent time trying to generate PDFs (see Blind Alleys below). PDFs are fragile to generate server-side. HTML files are:
- Trivial to generate from AI output
- Rendered well by the Vamoos app
- Easy to update (just regenerate and re-upload)
- No dependency on Puppeteer browser rendering

**The tool:** `upload_created_html_itinerary_document` takes `html_content`, wraps it in a full HTML document if needed, uploads to S3 as a `.html` file, and attaches to the itinerary.

### 5.2 GPX Tracks and Map Pins as POIs via JSON, Not File Upload
**Decision:** GPX tracks are parsed server-side into waypoints and POSTed to `/poi` as JSON with `type: "track"`. Named map pins are POSTed to `/poi` as JSON with `type: "poi"`. Both are then attached to the itinerary via the fetch-then-merge pattern.

**Why (GPX):** The Vamoos API does not have a working `/poi/gpx` endpoint that accepts raw GPX files. Multiple approaches were tried (see Blind Alleys). The working approach is:
1. Parse the GPX XML server-side with regex to extract `<trkpt lat=... lon=...>` points
2. POST to `/poi` with JSON: `{ type: "track", latitude, longitude, meta: { waypoints: [...] } }`
3. POST to `/itinerary` with `pois: [{ id: poi.id, is_on: true }]`

### 5.3 Vamoos API: POST for Both Create and Update
**Decision:** Use `POST /itinerary/{operator}/{reference_code}` for both creating AND updating trips.

**Why:** This is how the Vamoos API works — it's upsert behaviour. You don't use PUT. You always POST. The `vamoos_id` field, once known, should be passed on all updates to ensure you're updating the right record.

### 5.4 Hardcoded Operator Code
**Decision:** `OPERATOR_CODE = "alisdair"` is hardcoded in `src/index.ts`.

**Why:** This is a single-operator deployment for one Vamoos account.

### 5.5 API Token as Cloudflare Secret
**Decision:** `VAMOOS_API_TOKEN` is stored as a Cloudflare Workers secret, injected at runtime.

### 5.6 Zod Validation on All Tool Inputs
**Decision:** Every MCP tool parameter is validated with Zod schemas before execution.

### 5.7 `safeJson()` for All API Responses
**Decision:** All Vamoos API responses go through `safeJson()` which tries `JSON.parse()` and falls back to raw text on failure.

### 5.8 The System Prompt Is Separate from the Code
**Decision:** The AI's interview behaviour is defined in `SYSTEM_PROMPT.md`, not in the server code.

### 5.9 Two Separate Tools for Document Upload
**Decision:** `upload_created_html_itinerary_document` (AI-written) and `upload_document` (user-supplied) are separate tools with explicit descriptions.

### 5.10 Itinerary Updates Must Fetch-Then-Merge (Confirmed 19 March 2026)
**Decision:** Before POSTing any update to `/itinerary/{operator}/{ref}`, always GET the existing itinerary first, merge the new fields into the existing data, then POST the merged payload.

**Why:** The Vamoos itinerary POST is a **full overwrite**. Any field omitted from the POST body is cleared.

**Implementation pattern:**
```
body = { ...pickWritable(existing), vamoos_id, departure_date, return_date, <field being changed> }
```

`pickWritable()` whitelists only POST-safe fields and strips read-only server fields. Three fields need array-merge logic: `pois` (deduplicate by id), `documents.travel` (deduplicate by file_url), `locations` (append without dedup).

### 5.11 Detailed Step-by-Step Logging in GPX Tool
**Decision:** The `upload_gpx_and_attach_to_itinerary` tool returns a full log of every step including HTTP status codes.

### 5.12 Per-User Trip Filtering (29 March 2026)

**Problem:** `list_itineraries` returns all trips for the operator. We want the HomePage to show only trips belonging to the logged-in user (matched by email in the `travellers` list).

**Options considered:**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A — Vamoos API filter | Filter `GET /itinerary` by traveller email | Always accurate, zero extra storage | No documented traveller email filter. The `f` param only filters itinerary fields. Needs Vamoos developer confirmation — see TODO. |
| B — Netlify Blobs | Persistent key-value store keyed by email. Written at trip create and add-person time. Read on HomePage load. | Cross-device, no database, fits existing stack, free at this scale | Write points must be maintained; trips added outside this app won't appear automatically |
| C — localStorage | Client-side store per email | Trivially simple | Not cross-device; lost if browser storage cleared |
| D — Scan all trips | `list_itineraries` + `get_itinerary` on each to check travellers | Always accurate | Very slow with many trips; excessive API calls |

**Decision:** Option B (Netlify Blobs), pending Vamoos developer confirmation of Option A. If Option A is confirmed, replace with a single API call and remove the blob store.

**Implementation (29 March 2026):**
- `netlify/functions/trip-index.js` — new Netlify function; `POST { action: "get"|"add", email, trip? }` reads/writes a blob keyed by lowercase email address
- `@netlify/blobs` added to `package.json`
- `CreateTripPage.jsx` — calls `trip-index` (add) after successful `create_itinerary`; non-fatal
- `ChatPanel.jsx` — fires new `onPersonAdded(email, refCode)` prop when `add_person_to_itinerary` completes
- `TripPage.jsx` — wires `onPersonAdded` callback to call `trip-index` (add) with current trip info
- `HomePage.jsx` — calls `trip-index` (get) with logged-in email instead of `list_itineraries`

**Known limitation:** Trips created or people added outside this app won't appear until Option A is implemented.

---

## 6. Blind Alleys and Mistakes to Avoid

### 6.1 ❌ pdf-lib for PDF Generation
Replaced with Cloudflare Puppeteer. Now prefer HTML directly — no PDF needed for AI-written documents.

### 6.2 ❌ Markdown as the Document Format
Changed to instruct Claude to write proper HTML directly.

### 6.3 ❌ The `/poi/gpx` Endpoint
Abandoned. Use standard `/poi` JSON endpoint with `type: "track"` instead.

### 6.4 ❌ Using a Separate S3 Upload for GPX
GPX never goes to S3. Parsed in-memory and waypoints sent as structured JSON to `/poi`.

### 6.5 ❌ `list_itineraries` with Operator Code in URL Path
Fixed to `GET /itinerary` with `X-Operator-Code` in header only.

### 6.6 ❌ Merging generate_and_upload_pdf into upload_document
Created confusion. Separated into distinct tools with explicit descriptions.

### 6.7 ❌ AI Using upload_document for Its Own Generated Content
Fixed with explicit tool descriptions — "ALWAYS use this when YOU the assistant are generating content".

### 6.8 ❌ deploy.yml Watching `main` Branch
Fixed to `master` + `claude/**`.

---

## 7. Current State (29 March 2026)

### What Works
- ✅ Create/update/list/get itineraries via MCP tools
- ✅ Upload HTML documents and attach to trips
- ✅ Upload background images via S3
- ✅ GPX tracks: parse, create POI with waypoints, attach to itinerary
- ✅ `add_flight_to_itinerary`, `add_location_to_itinerary`, `add_person_to_itinerary` tools
- ✅ Chatbot UI: multi-page Vite/React app, Tailwind CSS 4, React Router, dark/orange theme
- ✅ CreateTripPage: form + auto ref code + parallel person add + Pixabay background
- ✅ TripPage: split-pane, Details tab (Claude Haiku formatted), Summary tab (HTML iframe)
- ✅ Summary tab: live preview when chatbot generates doc; Save button; loads saved version on page load via `fetch-document` proxy using `file.https_url`
- ✅ Person name set to user's email address (not hardcoded string)
- ✅ End-to-end confirmed on device — push notification received, trip in Vamoos app

### Known Limitations
- Operator code (`alisdair`) hardcoded — single-tenant only
- No auth on MCP server (by design)
- Per-user trip filtering uses Netlify Blobs (pending Vamoos API filter investigation)

---

## 8. File Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | All server code: tools, HTTP handlers, utilities |
| `SYSTEM_PROMPT.md` | AI interview behaviour and output instructions |
| `wrangler.jsonc` | Cloudflare Worker config |
| `package.json` | Dependencies |
| `.github/workflows/deploy.yml` | CI/CD: deploy to Cloudflare on push |

**Netlify Functions (`claude-code-chatbot-v1`):**

| File | Purpose |
|------|---------|
| `netlify/functions/chat.js` | Main agentic loop — Claude API + tool routing |
| `netlify/functions/mcp-tool.js` | Proxy to Cloudflare Worker MCP endpoint |
| `netlify/functions/format-trip.js` | Claude Haiku: raw JSON → readable text for Details tab |
| `netlify/functions/generate-trip-image.js` | Claude Haiku + Pixabay: background image on trip create |
| `netlify/functions/fetch-document.js` | Server-side proxy to fetch S3 HTML docs (avoids CORS) |
| `netlify/functions/trip-index.js` | Netlify Blobs: per-user trip index keyed by email |

---

## 9. Vamoos API Patterns (Cheat Sheet)

```
Base URL: https://live.vamoos.com/v3
Headers always needed:
  X-Operator-Code: alisdair
  X-User-Access-Token: <VAMOOS_API_TOKEN>
  Content-Type: application/json
  Accept: application/json

Create/update itinerary (upsert):
  POST /itinerary/{operator}/{reference_code}

Get itinerary:
  GET /itinerary/{operator}/{reference_code}

List itineraries:
  GET /itinerary?page=1&per_page=50
  (NO operator code in path — header only)

Get S3 upload URL:
  POST /file/upload_url
  Body: { filename, content_type }
  Returns: { url (pre-signed PUT URL), s3url (permanent S3 URL) }
```

---

## 10. Deployment

### 10.1 Cloudflare Worker (`ianball99/remote-mcp-server-authless`)
GitHub Actions (`deploy.yml`) triggers on `master` + `claude/**` branches.

### 10.2 Netlify Chatbot (`ianball99/claude-code-chatbot-v1`)
Netlify native GitHub integration. All branches deploy. Branch URL format: `https://<branch-slug>--<site-name>.netlify.app`.

### 10.3 Summary

| | Cloudflare Worker | Netlify Chatbot |
|---|---|---|
| **Repo** | `remote-mcp-server-authless` | `claude-code-chatbot-v1` |
| **Mechanism** | GitHub Actions | Netlify native |
| **Deploys from** | `master` + `claude/**` | All branches |
| **Secrets** | GitHub repo secrets | Netlify env vars |

---

*Document generated 18 March 2026 — updated through 29 March 2026*
