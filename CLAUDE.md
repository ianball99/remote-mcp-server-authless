# Project Notes

## Vamoos API — Itinerary Updates

**Confirmed (19 March 2026):** The Vamoos itinerary POST is a **full overwrite**. Any field omitted from the payload is deleted. All tools that update an itinerary must use a **fetch-then-merge** pattern:
1. GET the existing itinerary
2. Merge new fields into existing data (see deduplication rules in DESIGN_DOC.md §5.10)
3. POST the merged payload

**Exception:** `create_itinerary` is intentionally fresh — no fetch needed.
