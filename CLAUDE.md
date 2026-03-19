# Project Notes

## Vamoos API — Itinerary Updates

**Confirmed (19 March 2026):** The Vamoos itinerary POST is a **full overwrite**. Any field omitted from the payload is deleted. All tools that update an itinerary must use a **fetch-then-merge** pattern:
1. GET the existing itinerary
2. Merge new fields into existing data (see deduplication rules in DESIGN_DOC.md §5.10)
3. POST the merged payload

**Exception:** `create_itinerary` is intentionally fresh — no fetch needed.

## Deployment — Cloudflare Worker (this repo)

**Repo:** `ianball99/remote-mcp-server-authless` (public)

The GitHub Actions workflow (`.github/workflows/deploy.yml`) automatically deploys to Cloudflare Workers on every push to:
- `master`
- any `claude/**` branch

This means **commits pushed to the working `claude/...` branch are deployed immediately** — there is no need to merge to main first. Check Actions tab on GitHub to confirm a deploy succeeded after each push.

## Deployment — Chatbot UI (separate repo)

**Repo:** `ianball99/claude-code-chatbot-v1` (public), deployed via Netlify.

Netlify deploys from `main` only (confirmed). The observed pattern: a commit lands on the `claude/` branch first, then is pushed/merged to `main` within minutes, which triggers the Netlify production deploy. The 4:38pm deploy on 18 March 2026 confirms this — `main` was updated 2 minutes after the same commit appeared on the claude branch.
