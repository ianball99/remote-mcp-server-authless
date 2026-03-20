# Vamoos API — Confirmed Field Notes

These are confirmed behaviours discovered through live testing. Read this alongside `VAMOOS_API_SPEC.txt`.

---

## 1. POST is a Full Overwrite

**Confirmed 19 March 2026.** `POST /itinerary/{operator}/{ref}` replaces the entire itinerary. Any field omitted is deleted. Always use the fetch-then-merge pattern:

1. GET the existing itinerary
2. Extract only writable fields via `pickWritable()`
3. Merge new values on top
4. POST the merged payload

`pickWritable()` whitelists: `vamoos_id`, `departure_date`, `return_date`, `field1`–`field4`, `background`, `pois`, `documents`, `locations`, `storyboard`, `notifications`, `widgets`.

**Do NOT spread the raw GET response** — it contains read-only fields (`id`, `operator_id`, `version`, `is_current_version`, `created_at`, `updated_at`, `flights`, `downloads`, `routing`, `preview_link`, etc.) that the POST endpoint rejects.

---

## 2. Background Field — GET vs POST Shape Mismatch

This is the most important gotcha. The GET response and POST request use **completely different shapes** for `background`.

### What GET returns (`library_node_read`)

```json
{
  "id": 647611895,
  "tag": 647611895,
  "operator_id": 22091,
  "name": "Background Image",
  "file": {
    "id": 36927454,
    "operator_id": 22091,
    "mime_type": "image/jpeg",
    "s3_url": "s3://vamoos-live/uploads/alisdair/2026/3/19/xxx/background.jpg",
    "https_url": "https://vamoos-live.s3.eu-west-1.amazonaws.com/...(signed, expires)",
    "short_name": "background.jpg",
    "variants": {
      "app":  { "width": 2000, "height": 1325, "mime_type": "image/jpeg", "https_url": "..." },
      "thumb": { "width": 500,  "height": 331,  "mime_type": "image/jpeg", "https_url": "..." },
      "app_avif": { ... }
    },
    "is_public": false,
    "created_by": 5357,
    "created_at": "2026-03-19T14:06:21.000Z",
    "updated_at": "2026-03-19T14:06:25.000Z"
  },
  "is_folder": false,
  "path": "/itineraries/17934295/background/Background Image",
  "created_by": 5357,
  "created_at": "2026-03-19T14:06:21.000Z",
  "updated_at": "2026-03-19T14:06:21.000Z"
}
```

### What POST accepts (`file_url_upload_object`)

```json
{ "file_url": "s3://vamoos-live/uploads/..." }
```

### Round-trip mapping

To preserve background when POSTing an unrelated update (e.g. adding a document):

```
background.file.s3_url  →  POST body: { file_url: background.file.s3_url }
```

This is implemented in `sanitizeBackground()` in `src/index.ts`.

**Do NOT send** `id`, `tag`, `operator_id`, `is_folder`, `path`, `created_by`, `created_at`, `updated_at` — POST rejects all of these as `additionalProperties`.

---

## 3. Documents — GET vs POST Shape

### What GET returns

`documents.travel` is an array of `library_node_read` objects (same shape as background above).

The GET response also includes a computed `documents.all` array that merges travel and destination docs. **This field must never be sent in POST** — it is not a writable field and will cause `additionalProperties` validation errors. Confirmed 20 March 2026.

### What POST accepts

`documents.travel` is an array of `library_node_upload` objects:

```json
{ "file_url": "s3://vamoos-live/...", "name": "Document Name" }
```

### Round-trip mapping

```
doc.file_url  →  POST body travel item: { file_url: doc.file_url, name: doc.name }
```

The GET response for documents returns `file_url` directly on each travel item (not nested inside a `file` object like background). Deduplication is by `file_url`.

`getExistingDocuments()` in `src/index.ts` handles stripping to the writable shape and excluding `documents.all`.

---

## 3a. Locations — GET vs POST Shape

**Confirmed 20 March 2026.** The GET response for `locations[]` includes read-only server fields that the POST endpoint rejects:

| GET includes (read-only) | POST accepts |
|---|---|
| `id`, `itinerary_id` | ✗ |
| `country`, `country_iso` | ✗ |
| `timezone` | ✗ |
| `created_at`, `updated_at` | ✗ |
| `name`, `latitude`, `longitude` | ✓ |
| `description`, `icon_id` | ✓ |

Strip to `{ name, latitude, longitude }` (plus optional `description`, `icon_id`) before re-posting. Sending raw GET locations causes `additionalProperties.openapi.validation` errors.

This is handled inline in `pickWritable()`.

---

## 3b. Notifications — GET vs POST Shape

**Confirmed 20 March 2026.** Same issue as locations.

| GET includes (read-only) | POST accepts |
|---|---|
| `id`, `itinerary_id` | ✗ |
| `created_at`, `updated_at` | ✗ |
| `type`, `content`, `url`, `is_active` | ✓ |

Strip to `{ type, content, url, is_active }` before re-posting.

This is handled inline in `pickWritable()`.

---

## 4. S3 Upload Flow

```
POST /file/upload_url  { filename, content_type }
→  { url: "https://s3-presigned...", s3url: "s3://vamoos-live/..." }

PUT {url}  (binary file bytes, Content-Type header)
→  204 No Content

POST /itinerary/{op}/{ref}  { ..., background: { file_url: s3url } }
```

The `s3url` from step 1 is the value to use as `file_url` in the POST.

---

## 5. `pois` Round-trip

GET returns full `poi_get` objects. POST **itinerary** accepts `{ id: integer, is_on: boolean }` per POI — nothing else.

Round-trip: extract `{ id: poi.id, is_on: poi.is_on }` from each GET poi. Implemented in `getExistingPois()` / `mergePois()`.

### POI types (POST /poi)

When **creating** a POI (POST `/poi`), the `type` field controls rendering:

| `type` | Renders as | Key extra fields |
|---|---|---|
| `"track"` | Route line on map | `meta.waypoints: [{latitude, longitude}]` |
| `"poi"` | Named pin on map | `meta: {}` (empty) |

Both use the same other defaults: `icon_id: 1`, `is_default_on: true`, `poi_range: 100`, `location: null`, `position: null`, `description: null`, `file: null`, `timezone: null`, `children: []`, `localisation: {}`.

**Note:** In-app visibility behaviour of `is_default_on` and `poi_range` for both types not yet visually confirmed — to be verified with Alisdair.

---

## 6. Fields That Are Read-Only (Never Send in POST)

From `itinerary_read` — these are present in GET but must not be included in POST:

- `id`, `operator_id`, `operator_code`
- `version`, `is_current_version`
- `created_at`, `updated_at`
- `flights` (array of full flight objects — use `flight_ids` to set)
- `downloads`, `downloads_last30`
- `routing`, `preview_link`, `preview_link_id`, `preview_maps_link`
- `deactivated_at`, `deactivated_by`, `is_wiped`
- `is_listed`, `is_public`, `requested_listing_status`
- `travellers` (read via GET, written via `travellers` array in POST)
- `lead_traveller`

---

## 7. Writable Fields (Safe to Include in POST)

`vamoos_id` · `departure_date` · `return_date` · `timezone` · `start_time` · `client_reference` · `field1` · `field2` · `field3` · `field4` · `background` · `pois` · `documents` · `locations` · `notifications` · `storyboard` · `widgets` · `meta` · `logo` · `branding_profile_id` · `is_active`

---

## 8. Background — When Setting for the First Time

When uploading a new background image:

```json
{ "file_url": "s3://vamoos-live/...", "name": "Background Image" }
```

`name` is optional but recommended. The POST API accepts `file_url_upload_object` which only requires `file_url`.
