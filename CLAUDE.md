# Project Notes

## Vamoos API — Itinerary Updates

**Current approach:** The `pois` and `locations` fields in the itinerary POST are treated as **additive** (confirmed by testing). We do not fetch existing itinerary data before posting — we just append our new entries. Duplicates are acceptable.

**Safer alternative (if data loss is observed):** Switch to a fetch-then-merge pattern:
1. GET the existing itinerary to retrieve current `pois` and `locations` arrays.
2. Merge new entries into the existing arrays.
3. POST the merged payload.

This prevents overwriting data that was set outside of this tool. Revisit if unexpected data loss is reported.
