# Briefing: Vamoos Connect Venues — Session Handoff

> Created 14 June 2026. Paste/brief this into a new Claude Code session to continue the venues work.

## Repos & conventions
- **MCP server:** `ianball99/remote-mcp-server-authless` (Cloudflare Worker, single file `src/index.ts`). Auto-deploys on push to `master` and `claude/**` via GitHub Actions.
- **Chatbot:** `ianball99/claude-code-chatbot-v1` (Vite/React + Netlify functions). Deploys per-branch on Netlify; production tracks `main`.
- **Follow `CLAUDE.md`** in the MCP repo: do the session-start checklist, **present a plan and wait for approval before writing code**, develop on a `claude/` branch, and run the session-end doc-sync (DESIGN_DOC / TODO / PROGRESS_LOG to `master`).
- Read `DESIGN_DOC.md` **§5.21** and the **14 June 2026** `PROGRESS_LOG.md` entry first — they describe the venue tool already built.

## The requirement (overall goal)
While a user is chatting about a trip, whenever they **mention a hotel by name**, the assistant should look it up in the Vamoos **Connect** venue database and use the structured result (address, coordinates, stars, description, booking URL) to **enrich the itinerary** — preferring the venue DB over web search — and optionally add the venue to the trip map. This is `TODO.md` Priority 2 ("Connect Hotels API").

## What's DONE (live on `master`, deployed, verified)
1. **`find_venues` MCP tool** (`src/index.ts`) — read-only search of `GET /venues`. Exposes **all** filters as optional params: `query`, `country`, `latitude`/`longitude`/`radius`, `has_images`, `in_portfolio`, `facilities[]`, `classifications[]` (`hotel`/`hostel`/`bed_and_breakfast`/`villa`/`non_accommodation`), `stars[]` (1–5), `ids[]`, `owner_id`, `order_by`, `page`, `per_page`. Guard: `radius` requires lat+lon. Returns a **trimmed** summary (`pageNumber`, `pageSize`, `hasMore`, `count`, and per-venue `id`/`name`/`classification`/`stars`/`address`/`country`/coords/`description`/`url`/`bookingUrl`/`phone`/`email`/`imageCount`) — `longDescription` and raw image arrays are dropped.
2. **Connect auth wired up.** `CONNECT_API_KEY` is a Cloudflare secret, pushed by a CI step in `.github/workflows/deploy.yml` (mirrors `VAMOOS_API_TOKEN`; also a GitHub Actions repo secret of the same name). Typed in `worker-configuration.d.ts` and listed in `wrangler.jsonc`.
3. **Verified live** via `tools/call` on the deployed `/mcp` endpoint (`q="london hilton"`, `country="GB"` → correct results).

### Connect API facts (already confirmed — don't re-derive)
- Base URL: **`https://connect.vamoos.com/api`** (constant `CONNECT_BASE_URL`). Separate platform from legacy `live.vamoos.com/v3`.
- Auth: **`Authorization: Bearer <CONNECT_API_KEY>`** (NOT the legacy `X-User-Access-Token`).
- **Must** send **`x-operator-code: alisdair`** or you get `403 company_access_required`. (`alisdair` = the key's company slug, reuses the existing `OPERATOR_CODE` constant.)
- Each venue has a UUID `id` → a `get_venue_details` tool (`GET /venues/{id}`) is feasible later.

## What's NEXT (not started)
**Chatbot wiring** (`claude-code-chatbot-v1`), the main remaining work:
1. Add a `find_venues` tool definition to the `TOOLS` array in `netlify/functions/chat.js`. Decide **which subset of filters** to expose to the bot (the MCP tool has all of them; the bot likely needs `query` + `country` + maybe geo + `classifications=[hotel]`).
2. Add **system-prompt rules** in `chat.js` `SYSTEM`: detect hotel mentions → call `find_venues` (with country/geo to disambiguate) → prefer venue DB over `web_search` → if one confident match, enrich the itinerary; if several, show options and ask; if none, fall back to web search. Tie into the existing "never hallucinate / confirm before committing" ethos.
3. `netlify/functions/mcp-tool.js` needs **no change** — it proxies any MCP tool generically.

### Decisions to confirm with the user before coding
- Scope: `find_venues` only in the bot, or also build/expose a `get_venue_details` tool for the full record (longDescription, images)?
- Auto-enrich silently when confident, vs always "I found X — use it?" confirmation first.
- Should a found venue auto-add to the trip map (reuse `add_location_to_itinerary`/`add_poi_and_attach_to_itinerary` with its coords), or just feed text details into the HTML summary?
- **Discovery** (`POST /venues/discovery`, async 202 + poll `GET /venues/{id}` until `isProcessing=false`) for hotels not in inventory — recommend **deferring** (adds polling complexity to the synchronous chat loop).

### Known disambiguation issue
A bare name like "london hilton" returns ~10+ valid properties — the bot must narrow by country/coords or present choices.

## Gotchas / reminders
- **Don't set secrets via the Cloudflare dashboard** on this Worker — its versioned "Save and Deploy" rejects the Puppeteer `BROWSER` binding (`binding BROWSER ... cannot use version 1`). Use `wrangler secret put` / the CI step.
- **Branch deletion** must go through the GitHub REST API (`DELETE /repos/.../git/refs/heads/<branch>`); the git proxy returns 403 on `git push --delete`.
- **Rotate the Connect API key and the GitHub PAT** — both were pasted into the previous chat session.
- Last MCP `master` commit at handoff: `379298f`. The working branch `claude/keen-shannon-u9purx` is merged and deleted.

## Connect API reference (quick)
- `GET /venues` — paginated search (used by `find_venues`). Response: `{ hasMore, pageNumber, pageSize, items: venue[] }`.
- `GET /venues/{id}` — full venue details (for a future `get_venue_details`).
- `GET /venues/autocomplete?partial=` — lightweight name suggestions (≥3 chars).
- `POST /venues/discovery` — async build of an unknown venue from web sources (deferred).
- `GET /users/me` — returns the key's user + companies (used to confirm slug `alisdair`).
- All authenticated: `Authorization: Bearer <CONNECT_API_KEY>` + `x-operator-code: alisdair`.
