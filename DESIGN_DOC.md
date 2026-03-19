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

## 4. The 8 MCP Tools

| Tool | Purpose |
|------|---------|
| `create_itinerary` | Create a new trip in Vamoos |
| `update_itinerary` | Update an existing trip (requires `vamoos_id`) |
| `list_itineraries` | List all trips (paginated) |
| `get_itinerary` | Get full details of one trip by reference code |
| `upload_background_image` | Upload image to S3, attach as trip background |
| `upload_created_html_itinerary_document` | **Primary doc tool** — write HTML, upload as .html file |
| `upload_gpx_and_attach_to_itinerary` | Parse GPX, create POI, attach track to trip |
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

### 5.2 GPX Tracks as POIs via JSON, Not File Upload
**Decision:** GPX tracks are parsed server-side into waypoints, then POSTed to the Vamoos `/poi` endpoint as a JSON object with `type: "track"` and `meta.waypoints` array.

**Why:** The Vamoos API does not have a working `/poi/gpx` endpoint that accepts raw GPX files. Multiple approaches were tried (see Blind Alleys). The working approach is:
1. Parse the GPX XML server-side with regex to extract `<trkpt lat=... lon=...>` points
2. POST to `/poi` with JSON: `{ type: "track", latitude, longitude, meta: { waypoints: [...] } }`
3. POST to `/itinerary` with `pois: [{ id: poi.id, is_on: true }]`

**POI fields that matter:**
- `type: "track"` — tells Vamoos to render as a route line, not a pin
- `is_default_on: true` — track is visible by default in the app without user enabling it
- `meta.waypoints` — array of `{latitude, longitude}` objects containing the full route
- `latitude`, `longitude` — the first waypoint, used as the POI anchor point
- `icon_id: 1` — default icon (required by API)

### 5.3 Vamoos API: POST for Both Create and Update
**Decision:** Use `POST /itinerary/{operator}/{reference_code}` for both creating AND updating trips.

**Why:** This is how the Vamoos API works — it's upsert behaviour. You don't use PUT. You always POST. The `vamoos_id` field, once known, should be passed on all updates to ensure you're updating the right record.

### 5.4 Hardcoded Operator Code
**Decision:** `OPERATOR_CODE = "alisdair"` is hardcoded in `src/index.ts`.

**Why:** This is a single-operator deployment for one Vamoos account. If multi-operator support were needed, this would need to become a secret or a parameter.

### 5.5 API Token as Cloudflare Secret
**Decision:** `VAMOOS_API_TOKEN` is stored as a Cloudflare Workers secret, injected at runtime.

**Why:** Never hardcode credentials. The token is pushed via `wrangler secret put` during CI/CD deployment and is available as `env.VAMOOS_API_TOKEN` at runtime.

### 5.6 Zod Validation on All Tool Inputs
**Decision:** Every MCP tool parameter is validated with Zod schemas before execution.

**Why:** MCP tool calls come from the AI model, which can hallucinate parameters. Zod catches type errors, missing fields, and format violations (e.g. date regex `^\d{4}-\d{2}-\d{2}$`) before they hit the API.

### 5.7 `safeJson()` for All API Responses
**Decision:** All Vamoos API responses go through `safeJson()` which tries `JSON.parse()` and falls back to raw text on failure.

**Why:** The Vamoos API sometimes returns HTML error pages (e.g. 500 errors, redirects) instead of JSON. Without this, JSON.parse throws and the actual error message is lost.

### 5.8 The System Prompt Is Separate from the Code
**Decision:** The AI's interview behaviour is defined in `SYSTEM_PROMPT.md`, not in the server code.

**Why:** The system prompt controls how Claude conducts the trip planning interview, what questions to ask, and how to format and upload documents. Keeping it separate means it can be iterated without redeploying the Worker. The prompt is loaded into Claude's context when starting a session.

### 5.9 Two Separate Tools for Document Upload
**Decision:** `upload_created_html_itinerary_document` (for AI-written docs) and `upload_document` (for user-supplied files) are separate tools with different descriptions.

**Why:** Originally one tool was used for both. The AI kept using the wrong mode or getting confused. Splitting them with very explicit descriptions ("ALWAYS use this when YOU the assistant are generating content") fixed the routing. The tool descriptions are instructions to the model.

### 5.10 Itinerary Updates Must Fetch-Then-Merge (Confirmed 19 March 2026)
**Decision:** Before POSTing any update to `/itinerary/{operator}/{ref}`, always GET the existing itinerary first, merge the new fields into the existing data, then POST the merged payload.

**Why:** Testing confirmed that the Vamoos itinerary POST is a **full overwrite**, not a partial update. Any field omitted from the POST body is cleared. For example, uploading a background image without including the existing `pois` and `documents` in the payload will silently delete all POIs and documents from the trip.

**Implementation pattern (confirmed 19 March 2026):** Spread the full existing record into the payload first, then overlay only the fields being changed:

```
body = { ...existing, vamoos_id, departure_date, return_date, <field being changed> }
```

This means any field Vamoos adds in future (`flights`, `extras`, etc.) survives automatically without code changes.

**Three fields require array-merge logic rather than simple overwrite:**
- `pois` — deduplicate by `id` (new entry wins if same id appears twice): `mergePois(existing, incoming)`
- `documents.travel` — deduplicate by `file_url` (new entry wins): `mergeTravelDocs(existing, incoming)`
- `locations` — append without deduplication (same name + different coords is valid): `[...existing, ...incoming]`

**All other fields** (background, scalars, and any future unknown fields) are handled correctly by the spread — new value overwrites, existing values survive if not touched.

**Exception:** `create_itinerary` intentionally creates a fresh record and does NOT fetch first. All other tools that call POST /itinerary must fetch first.

**Helper:** `fetchItinerary(referenceCode, token)` handles the GET and returns parsed JSON (or a safe empty object `{}` on 404/error).

### 5.11 Detailed Step-by-Step Logging in GPX Tool
**Decision:** The `upload_gpx_and_attach_to_itinerary` tool returns a full log of every step, including HTTP status codes and response bodies.

**Why:** GPX upload involved significant debugging. Verbose logging in the tool response means when something goes wrong, Claude can report exactly which step failed and what the API returned, without needing to add print statements or redeploy.

---

## 6. Blind Alleys and Mistakes to Avoid

### 6.1 ❌ pdf-lib for PDF Generation
**What happened:** First attempt at document upload used `pdf-lib` to generate PDFs from text. This created real PDFs but with very limited formatting — no HTML/CSS rendering, font issues, Unicode character crashes.

**What went wrong:** `pdf-lib` works at the raw PDF primitive level. Any special character (`–`, `"`, etc.) caused `drawText` to throw. The resulting PDFs looked plain and crashed on non-ASCII text.

**What we did:** Replaced with Cloudflare Puppeteer, which launches a real Chrome browser and renders HTML to PDF properly.

**Current status:** Puppeteer PDF generation still exists in `upload_document` (mode 1) and `legacy_upload_created_itinerary_document`. But for AI-written documents we now prefer uploading as HTML directly (no PDF needed).

### 6.2 ❌ Markdown as the Document Format
**What happened:** We went through a phase where the system prompt instructed Claude to write documents in markdown, then converted them server-side to HTML/PDF.

**What went wrong:** The server-side markdown→HTML converter was hand-rolled (`markdownToHtml()`) and incomplete. It handled basic headings and bullets but not tables, nested lists, inline code, etc. Output was inconsistent.

**What we did:** Changed the system prompt to instruct Claude to write proper HTML directly. Claude is very capable of writing clean HTML. The server just uploads it as-is (with a wrapper if needed). The hand-rolled converter is still in the code but no longer used for the primary flow.

### 6.3 ❌ The `/poi/gpx` Endpoint
**What happened:** Spent several iterations trying to use a `POST /poi/gpx` endpoint to upload raw GPX files directly to Vamoos.

**What went wrong:** This endpoint either doesn't exist or doesn't behave as expected. We tried:
- Raw `application/gpx+xml` body
- `multipart/form-data`
- Various header combinations

All attempts failed. The API returned errors.

**What we did:** Abandoned the dedicated GPX endpoint entirely. Instead, parse the GPX ourselves and use the standard `/poi` JSON endpoint with `type: "track"`. This works reliably.

**Lesson:** When an API endpoint doesn't work, try the generic data endpoint with the right JSON structure instead of fighting with a specialised endpoint.

### 6.4 ❌ Using a Separate S3 Upload for GPX
**What happened:** Early GPX implementation uploaded the GPX file to S3 (same as images/documents) and tried to attach it as a file-type POI.

**What went wrong:** Vamoos doesn't consume GPX files from S3 URLs for POIs. The POI creation requires structured data (waypoints as JSON), not a file URL.

**What we did:** GPX now never goes to S3. It's parsed in-memory and the waypoints are sent as structured JSON to `/poi`.

### 6.5 ❌ `list_itineraries` with Operator Code in URL Path
**What happened:** `list_itineraries` initially called `GET /itinerary/{operator_code}` (with operator code in the path).

**What went wrong:** This returned a 404 or redirect. The correct endpoint is `GET /itinerary` (no operator code in path — it's passed in the header).

**What we did:** Fixed to `GET /itinerary` with `X-Operator-Code` in the header only.

**Lesson:** The Vamoos API is inconsistent — some endpoints use `/{operator}/{ref}` in the path, the list endpoint does not. Always check the actual response and don't assume symmetry.

### 6.6 ❌ Merging generate_and_upload_pdf into upload_document
**What happened:** A tool called `generate_and_upload_pdf` was created then immediately merged into `upload_document` as "mode 1".

**What went wrong:** This created a complex dual-mode tool that was harder to describe to the model. The AI would sometimes pick the wrong mode.

**What we did:** Kept the dual-mode `upload_document` but added a separate single-purpose tool `upload_created_html_itinerary_document` for the AI-generated-content case. Separation of concerns in tool design matters.

### 6.7 ❌ AI Using upload_document for Its Own Generated Content
**What happened:** When only `upload_document` existed, the AI would sometimes try to upload its own generated itinerary as a user-supplied binary file (mode 2), which obviously doesn't work.

**What went wrong:** The tool description wasn't specific enough about which tool to use for AI-generated vs user-supplied content.

**What we did:** Added very explicit tool descriptions. `upload_created_html_itinerary_document` says "ALWAYS use this tool when YOU (the assistant) are generating content". `upload_document` says "use this ONLY when the user has provided a file". In MCP, tool descriptions are literally instructions to the model.

### 6.8 ❌ deploy.yml Watching `main` Branch
**What happened:** The GitHub Actions deploy workflow was configured to trigger on pushes to `main`.

**What went wrong:** The repo uses `master` (not `main`) as the primary branch, so auto-deploys never fired.

**What we did:** Changed trigger to `master` branch. Also added `claude/**` branch pattern so Claude's working branches also trigger a deploy during development.

---

## 7. Current State (18 March 2026)

### What Works
- ✅ Create/update/list/get itineraries via MCP tools
- ✅ Upload HTML documents and attach to trips (rendered in Vamoos app)
- ✅ Upload background images via S3
- ✅ GPX tracks: parse, create POI with waypoints, attach to itinerary
- ✅ POI appears in `get_itinerary` response
- ✅ AI interview flow (SYSTEM_PROMPT.md) guides trip data capture
- ✅ Auto-deploy on push via GitHub Actions

### Under Investigation / Next Steps
- 🔍 Verify GPX track displays correctly as a route line in the Vamoos mobile app (not just a pin)
- 🔍 Confirm `type: "track"` with `meta.waypoints` is rendered as expected on the map
- 🔍 Test with a real, large GPX file (the current test.gpx has only 3 points)
- ❓ The `upload_document` Puppeteer/PDF path is untested end-to-end after the HTML→direct-upload change

### Known Limitations
- Operator code (`alisdair`) is hardcoded — single-tenant only
- No authentication on the MCP server itself (by design — "authless")
- `legacy_upload_created_itinerary_document` left in codebase but should eventually be removed
- The markdown→HTML converter (`markdownToHtml()`) and `wrapHtmlIfNeeded()` are still present but are now only used by the legacy/PDF path

---

## 8. File Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | All server code: tools, HTTP handlers, utilities |
| `SYSTEM_PROMPT.md` | AI interview behaviour and output instructions |
| `wrangler.jsonc` | Cloudflare Worker config (bindings, secrets, compatibility) |
| `package.json` | Dependencies (agents, zod, puppeteer, wrangler) |
| `.github/workflows/deploy.yml` | CI/CD: deploy to Cloudflare on push |
| `test.gpx` | Minimal 3-point GPX file for API testing |
| `worker-configuration.d.ts` | TypeScript types for `Env` (secrets + bindings) |

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
  Body: { departure_date, return_date, vamoos_id (for updates), field1, field3, background, documents, pois }

Get itinerary:
  GET /itinerary/{operator}/{reference_code}

List itineraries:
  GET /itinerary?page=1&per_page=50
  (NO operator code in path — header only)

Create POI (including tracks):
  POST /poi
  Body: { name, latitude, longitude, type: "track", icon_id: 1,
          is_default_on: true, poi_range: 100,
          meta: { waypoints: [{latitude, longitude}, ...] },
          location: null, position: null, description: null,
          file: null, timezone: null, children: [], localisation: {} }

Get S3 upload URL:
  POST /file/upload_url
  Body: { filename, content_type }
  Returns: { url (pre-signed PUT URL), s3url (permanent S3 URL) }

Attach file to itinerary:
  POST /itinerary/{operator}/{ref}
  Body: { vamoos_id, departure_date, return_date,
          background: { file_url: s3url, name: "..." }
          — OR —
          documents: { travel: [{ file_url: s3url, name: "..." }] }
          — OR —
          pois: [{ id: poi_id, is_on: true }] }
```

---

*Document generated 18 March 2026*
