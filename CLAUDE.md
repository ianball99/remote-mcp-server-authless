# Project Notes

## Session Start Checklist

At the start of every session, Claude must do the following **before any other work**:

1. **Remind the user** to add the chatbot repo to the session: `ianball99/claude-code-chatbot-v1`
2. **Ask the user for their GitHub Personal Access Token** (needed for pushing to repos)
3. **Read this file (CLAUDE.md)** and **DESIGN_DOC.md** — always fetch the latest versions from `master` on `ianball99/remote-mcp-server-authless`
4. **If the session involves Vamoos API work**, also read **VAMOOS_API_SPEC.txt** and **VAMOOS_FIELD_NOTES.md** from `master` — these document the official API schema and confirmed GET/POST field mappings
5. **Read TODO.md** (in this repo, `master` branch), show the user the open items, then **ask what they want to work on**

---

## Session End Checklist

At the end of every session, Claude must:

1. **Update DESIGN_DOC.md** to reflect any changes made this session
2. **Check with user** then update TODO.md — mark completed items, add newly discovered items
3. **Update PROGRESS_LOG.md** with a summary of what was done today
4. **Push all updated docs to `master`** using the GitHub PAT (ask user for PAT if not already set). Files to sync: `CLAUDE.md`, `DESIGN_DOC.md`, `TODO.md`, `PROGRESS_LOG.md`, and any new reference files
5. **Check with user, then merge the `claude/` branch back to `master`** (this repo). Use:
   ```
   git checkout master && git merge <claude-branch> && git push origin master
   ```
6. **Check with user, then merge any chatbot `claude/` branch back to `main`** (`ianball99/claude-code-chatbot-v1`). This triggers the Netlify production deploy. Use:
   ```
   git checkout main && git merge <claude-branch> && git push origin main
   ```
7. **Delete merged `claude/` branches** from both repos to keep GitHub tidy:
   ```
   curl -X DELETE -H "Authorization: token <PAT>" \
     https://api.github.com/repos/ianball99/remote-mcp-server-authless/git/refs/heads/<claude-branch>
   curl -X DELETE -H "Authorization: token <PAT>" \
     https://api.github.com/repos/ianball99/claude-code-chatbot-v1/git/refs/heads/<claude-branch>
   ```

---

## Doc Sync Rule

Whenever `CLAUDE.md`, `DESIGN_DOC.md`, `PROGRESS_LOG.md` or other reference docs are updated on a `claude/` branch, they must also be pushed to `master` so the latest versions are always available at session start.

**How to push docs to master with PAT:**
```
git remote set-url origin https://<PAT>@github.com/ianball99/remote-mcp-server-authless.git
git checkout master
git checkout <claude-branch> -- CLAUDE.md DESIGN_DOC.md TODO.md PROGRESS_LOG.md VAMOOS_API_SPEC.txt VAMOOS_FIELD_NOTES.md
git commit -m "Sync docs to master"
git push origin master
git checkout <claude-branch>
```

**IMPORTANT — if a push to `master` gets a 403 error:** This is NOT because the sandbox blocks pushes to `master`. It is simply because the PAT has not been configured on the remote URL. Set it with `git remote set-url` as above and the push will succeed. Never tell the user they need to do this manually or that only `claude/` branches can be pushed — that is wrong.

## Progress Log

**`PROGRESS_LOG.md`** tracks what was worked on each day. It must be updated **during the session** (not just at the end) since sessions may span multiple days. Add a dated entry at the top each day work is done.

---


## Vamoos API Reference Files

- **`VAMOOS_API_SPEC.txt`** — Official Vamoos OpenAPI spec (v5.0.20251003). Source of truth for schema definitions.
- **`VAMOOS_FIELD_NOTES.md`** — Confirmed field mappings and gotchas from live testing. Read this before touching any Vamoos API code. Key sections:
  - §2 Background GET vs POST shape mismatch (critical — caused multiple bugs)
  - §3 Documents round-trip mapping
  - §4 S3 upload flow
  - §6/7 Read-only vs writable fields

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

This means **commits pushed to the working `claude/...` branch are deployed immediately** — there is no need to merge to `master` first. Check Actions tab on GitHub to confirm a deploy succeeded after each push.

## Deployment — Chatbot UI (separate repo)

**Repo:** `ianball99/claude-code-chatbot-v1` (public), deployed via Netlify.

Netlify deploys from `main` only (confirmed). The deployment flow is:
1. Commit lands on the `claude/` branch first
2. **Once the user agrees to the changes, Claude immediately pushes to `main`** — there is no GitHub Actions automation for this step
3. The push to `main` triggers the Netlify production deploy

**Netlify will not deploy until `main` is updated.**
