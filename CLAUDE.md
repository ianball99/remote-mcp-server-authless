# Project Notes

## Session Start Checklist

At the start of every session, Claude must do the following **before any other work**:

1. **Remind the user** to add the chatbot repo to the session: `ianball99/claude-code-chatbot-v1`
2. **Ask the user for their GitHub Personal Access Token** (needed for pushing to repos)
3. **Read this file (CLAUDE.md)** and **DESIGN_DOC.md** — always fetch the latest versions from `main` on `ianball99/remote-mcp-server-authless`
4. **Read TODO.md** (in this repo, `main` branch), show the user the open items, then **ask what they want to work on**

---

## Session End Checklist

At the end of every session, Claude must:

1. **Update DESIGN_DOC.md** to reflect any changes made this session
2. **Check with user** then update TODO.md — mark completed items, add newly discovered items
3. **Push CLAUDE.md and DESIGN_DOC.md to `main`** if they were updated on a `claude/` branch
4. **Check with user before merging** any `claude/` branch back to `main`

---

## Doc Sync Rule

Whenever `CLAUDE.md` or `DESIGN_DOC.md` are updated on a `claude/` branch, they must also be pushed to `main` so the latest versions are always available at session start.

---


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

Netlify deploys from `main` only (confirmed). The deployment flow is:
1. Commit lands on the `claude/` branch first
2. **Once the user agrees to the changes, Claude immediately pushes to `main`** — there is no GitHub Actions automation for this step
3. The push to `main` triggers the Netlify production deploy

**Netlify will not deploy until `main` is updated.**
