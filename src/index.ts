import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import puppeteer from "@cloudflare/puppeteer";
import { z } from "zod";

const VAMOOS_BASE_URL = "https://live.vamoos.com/v3";
const CONNECT_BASE_URL = "https://connect.vamoos.com/api";
const OPERATOR_CODE = "alisdair";

function parseGpx(gpxContent: string): { latitude: string; longitude: string; waypoints: Array<{ latitude: string; longitude: string }> } {
	const waypointRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g;
	const waypoints: Array<{ latitude: string; longitude: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = waypointRegex.exec(gpxContent)) !== null) {
		waypoints.push({ latitude: match[1], longitude: match[2] });
	}
	if (waypoints.length === 0) {
		throw new Error("No track points found in GPX content");
	}
	return { latitude: waypoints[0].latitude, longitude: waypoints[0].longitude, waypoints };
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function safeJson(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function getS3UploadUrl(
	filename: string,
	contentType: string,
	token: string,
): Promise<{ url: string; s3url: string }> {
	const response = await fetch(`${VAMOOS_BASE_URL}/file/upload_url`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"X-Operator-Code": OPERATOR_CODE,
			"X-User-Access-Token": token,
		},
		body: JSON.stringify({ filename, content_type: contentType }),
	});
	if (!response.ok) {
		const data = await safeJson(response);
		throw new Error(`Failed to get S3 upload URL: ${JSON.stringify(data)}`);
	}
	return safeJson(response) as Promise<{ url: string; s3url: string }>;
}

async function uploadToS3(url: string, fileData: Uint8Array, contentType: string): Promise<void> {
	const response = await fetch(url, {
		method: "PUT",
		headers: { "Content-Type": contentType },
		body: fileData,
	});
	if (!response.ok) {
		throw new Error(`S3 upload failed with status ${response.status}`);
	}
}

// Converts plain markdown to HTML. Handles # headings, **bold**, - bullets, and paragraphs.
function markdownToHtml(markdown: string): string {
	const lines = markdown.split("\n");
	const parts: string[] = [];
	let listOpen = false;

	const closeList = () => {
		if (listOpen) {
			parts.push("</ul>");
			listOpen = false;
		}
	};

	for (const raw of lines) {
		const line = raw.trimEnd();

		if (/^### /.test(line)) {
			closeList();
			parts.push(`<h3>${escHtml(line.slice(4))}</h3>`);
		} else if (/^## /.test(line)) {
			closeList();
			parts.push(`<h2>${escHtml(line.slice(3))}</h2>`);
		} else if (/^# /.test(line)) {
			closeList();
			parts.push(`<h1>${escHtml(line.slice(2))}</h1>`);
		} else if (/^[-*] /.test(line)) {
			if (!listOpen) { parts.push("<ul>"); listOpen = true; }
			parts.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
		} else if (line === "") {
			closeList();
			parts.push("");
		} else {
			closeList();
			parts.push(`<p>${inlineMarkdown(line)}</p>`);
		}
	}
	closeList();
	return parts.join("\n");
}

function escHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMarkdown(s: string): string {
	return escHtml(s).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
}

// Wraps an HTML fragment in a full document if needed, so Puppeteer can render it correctly.
function wrapHtmlIfNeeded(html: string, title: string): string {
	if (/<html/i.test(html)) return html;
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;margin:40px}h1{font-size:18px;margin:0 0 12px}h2{font-size:14px;margin:20px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}p{margin:0 0 8px}ul{margin:0 0 8px;padding-left:20px}li{margin-bottom:3px}</style></head><body>${html}</body></html>`;
}

async function generatePdfFromHtml(html: string, env: Env): Promise<Uint8Array> {
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setContent(html, { waitUntil: "networkidle0" });
		const pdfBuffer = await page.pdf({
			format: "A4",
			printBackground: true,
			margin: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" },
		});
		return new Uint8Array(pdfBuffer);
	} finally {
		await browser.close();
	}
}

// ── Fetch-then-merge helpers ────────────────────────────────────────────────

type PoiRef = { id: number; is_on: boolean };
type TravelDoc = { file_url: string; name: string };

// Fields the Vamoos POST /itinerary API accepts. Read-only server fields
// (id, operator_id, version, created_at, flights, etc.) must NOT be sent back.
// Source of truth: itinerary_write schema in VAMOOS_API_SPEC.txt (additionalProperties: false).
const WRITABLE_ITINERARY_FIELDS = [
	"vamoos_id", "departure_date", "return_date", "timezone",
	"field1", "field2", "field3", "field4",
	"background", "pois", "documents", "locations",
	"notifications", "meta", "travellers",
] as const;

// The GET response returns background/documents as full library_node_read objects
// (with id, tag, operator_id, file.s3_url, path, created_at, etc.) but the POST
// schema only accepts library_node_upload shapes. Strip down to just what POST accepts.
// NOTE: the GET response stores the URL in "file.s3_url" — we map it to "file_url" for POST.
function sanitizeLibraryNode(node: unknown): Record<string, unknown> | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const n = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	// Preserve name if present
	if (typeof n.name === "string") out.name = n.name;
	// Case 1: already a file_url_upload_object (has file_url directly)
	if (typeof n.file_url === "string") {
		out.file_url = n.file_url;
		return out;
	}
	// Case 2: library_node_read — URL is nested at file.s3_url
	if (typeof n.file === "object" && n.file !== null) {
		const f = n.file as Record<string, unknown>;
		if (typeof f.s3_url === "string") {
			out.file_url = f.s3_url;
			return out;
		}
	}
	// Case 3: library_node_upload_object — reference by id
	if (typeof n.library_node_id === "number") {
		out.library_node_id = n.library_node_id;
		return out;
	}
	return undefined;
}

function sanitizeBackground(bg: unknown): unknown {
	return sanitizeLibraryNode(bg);
}

function pickWritable(existing: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of WRITABLE_ITINERARY_FIELDS) {
		if (existing[key] === undefined) continue;
		if (key === "background") {
			const sanitized = sanitizeBackground(existing[key]);
			if (sanitized !== undefined) out[key] = sanitized;
		} else if (key === "documents") {
			// Strip read-only server fields and documents.all (computed); sanitize to writable shape
			const { travel, destination } = getExistingDocuments(existing);
			if (travel.length > 0 || destination.length > 0) {
				const docsOut: Record<string, unknown> = { travel };
				if (destination.length > 0) docsOut.destination = destination;
				out[key] = docsOut;
			}
		} else if (key === "locations") {
			// location_read includes id, itinerary_id, country, country_iso, timezone, created_at, updated_at
			// location_write accepts name, latitude, longitude, description, icon_id and meta
			// (meta carries e.g. connect_id linking a location to a Connect venue — confirmed persisted by Vamoos)
			const locs = existing[key];
			if (Array.isArray(locs) && locs.length > 0) {
				out[key] = locs.map((loc: unknown) => {
					const l = loc as Record<string, unknown>;
					const w: Record<string, unknown> = { name: l.name, latitude: l.latitude, longitude: l.longitude };
					if (l.description !== undefined) w.description = l.description;
					if (l.icon_id !== undefined) w.icon_id = l.icon_id;
					if (l.meta !== undefined) w.meta = l.meta;
					return w;
				});
			}
		} else if (key === "notifications") {
			// notification_get includes id, itinerary_id, created_at, updated_at
			// notification_write only accepts type, content, url, is_active (additionalProperties: false)
			const notifs = existing[key];
			if (Array.isArray(notifs) && notifs.length > 0) {
				out[key] = notifs.map((n: unknown) => {
					const notif = n as Record<string, unknown>;
					const w: Record<string, unknown> = { type: notif.type };
					if (notif.content !== undefined) w.content = notif.content;
					if (notif.url !== undefined) w.url = notif.url;
					if (notif.is_active !== undefined) w.is_active = notif.is_active;
					return w;
				});
			}
		} else if (key === "travellers") {
			// traveller_read includes id, tag, itinerary_id, created_at, updated_at (all read-only)
			// writable fields are: name, email, details, is_active
			const travellers = existing[key];
			if (Array.isArray(travellers) && travellers.length > 0) {
				out[key] = travellers.map((t: unknown) => {
					const tr = t as Record<string, unknown>;
					const w: Record<string, unknown> = {};
					if (tr.name !== undefined) w.name = tr.name;
					if (tr.email !== undefined) w.email = tr.email;
					if (tr.details !== undefined) w.details = tr.details;
					if (tr.is_active !== undefined) w.is_active = tr.is_active;
					return w;
				});
			}
		} else {
			out[key] = existing[key];
		}
	}
	// flights is read-only in GET (full flight_get objects) but the writable form is flight_ids.
	// Derive flight_ids from existing flights so they are preserved on any itinerary update.
	const rawFlights = existing.flights;
	if (Array.isArray(rawFlights) && rawFlights.length > 0) {
		out.flight_ids = (rawFlights as Array<{ id: number }>).map(f => f.id);
	}
	return out;
}

async function fetchItinerary(referenceCode: string, token: string): Promise<Record<string, unknown>> {
	const response = await fetch(
		`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(referenceCode)}`,
		{
			method: "GET",
			headers: {
				Accept: "application/json",
				"X-Operator-Code": OPERATOR_CODE,
				"X-User-Access-Token": token,
			},
		},
	);
	if (!response.ok) return {};
	const data = await safeJson(response);
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

function getExistingPois(existing: Record<string, unknown>): PoiRef[] {
	const pois = existing.pois;
	if (!Array.isArray(pois)) return [];
	return pois
		.filter((p): boolean => typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).id === "number")
		.map(p => {
			const poi = p as Record<string, unknown>;
			return { id: poi.id as number, is_on: typeof poi.is_on === "boolean" ? poi.is_on : true };
		});
}

// Extracts travel/destination doc arrays from GET response, sanitizing library_node_read
// objects into the library_node_upload shape expected by POST.
function getExistingDocuments(existing: Record<string, unknown>): { travel: TravelDoc[]; destination: TravelDoc[] } {
	const docs = existing.documents;
	if (typeof docs !== "object" || docs === null) return { travel: [], destination: [] };
	const d = docs as Record<string, unknown>;

	const extractDocs = (arr: unknown): TravelDoc[] => {
		if (!Array.isArray(arr)) return [];
		return arr
			.map(sanitizeLibraryNode)
			.filter((item): item is Record<string, unknown> => item !== undefined && typeof item.file_url === "string")
			.map(item => ({ file_url: item.file_url as string, name: typeof item.name === "string" ? item.name : "" }));
	};

	return {
		travel: extractDocs(d.travel),
		destination: extractDocs(d.destination),
	};
}

// Legacy accessor kept for call sites that only need travel docs
function getExistingTravelDocs(existing: Record<string, unknown>): TravelDoc[] {
	return getExistingDocuments(existing).travel;
}

// Builds the full documents POST body, merging new travel docs and preserving destination docs.
function buildDocumentsBody(existing: Record<string, unknown>, newTravelDocs: TravelDoc[]): Record<string, unknown> {
	const { travel, destination } = getExistingDocuments(existing);
	const result: Record<string, unknown> = { travel: mergeTravelDocs(travel, newTravelDocs) };
	if (destination.length > 0) result.destination = destination;
	return result;
}

function mergePois(existing: PoiRef[], incoming: PoiRef[]): PoiRef[] {
	const map = new Map<number, PoiRef>();
	for (const p of existing) map.set(p.id, p);
	for (const p of incoming) map.set(p.id, p); // new wins on same id
	return Array.from(map.values());
}

function mergeTravelDocs(existing: TravelDoc[], incoming: TravelDoc[]): TravelDoc[] {
	const map = new Map<string, TravelDoc>();
	for (const d of existing) map.set(d.file_url, d);
	for (const d of incoming) map.set(d.file_url, d); // new wins on same file_url
	return Array.from(map.values());
}

// ────────────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
} as const;

async function handleUpload(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return new Response(JSON.stringify({ error: "Method not allowed" }), {
			status: 405,
			headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
		});
	}
	try {
		const formData = await request.formData();
		const file = formData.get("file") as File | null;
		if (!file) {
			return new Response(JSON.stringify({ error: "No file provided" }), {
				status: 400,
				headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
			});
		}

		const referenceCode = String(formData.get("reference_id") || formData.get("reference_code") || "");
		const filename = String(formData.get("image_filename") || file.name);
		const contentType = String(formData.get("image_content_type") || file.type || "application/octet-stream");
		const uploadType = String(formData.get("upload_type") || "background");
		const documentName = String(formData.get("document_name") || "Document");

		if (!referenceCode) {
			return new Response(
				JSON.stringify({ error: "Missing required field: reference_id" }),
				{ status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
			);
		}

		const fileData = new Uint8Array(await file.arrayBuffer());

		// GPX track — parse waypoints and create a POI (no S3 upload needed)
		if (uploadType === "gpx") {
			const gpxText = new TextDecoder().decode(fileData);
			const { latitude, longitude, waypoints } = parseGpx(gpxText);
			const poiName = filename.replace(/\.gpx$/i, "");

			const poiResponse = await fetch(`${VAMOOS_BASE_URL}/poi`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"X-Operator-Code": OPERATOR_CODE,
					"X-User-Access-Token": env.VAMOOS_API_TOKEN,
				},
				body: JSON.stringify({
					name: poiName,
					location: null,
					latitude,
					longitude,
					position: null,
					description: null,
					icon_id: 1,
					timezone: null,
					is_default_on: true,
					poi_range: 100,
					file: null,
					meta: { waypoints },
					type: "track",
					children: [],
					localisation: {},
				}),
			});

			const poiData = await safeJson(poiResponse);
			if (!poiResponse.ok) {
				return new Response(JSON.stringify({ ok: false, error: `Failed to create POI: ${JSON.stringify(poiData)}` }), {
					status: poiResponse.status,
					headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
				});
			}

			const poi = poiData as { id: number };

			// Fetch existing itinerary, spread all fields, merge pois/locations
			const existing = await fetchItinerary(referenceCode, env.VAMOOS_API_TOKEN);
			const writableExisting = pickWritable(existing);
			const mergedPois = mergePois(getExistingPois(existing), [{ id: poi.id, is_on: true }]);
			const existingLocations = Array.isArray(writableExisting.locations) ? writableExisting.locations as Record<string, unknown>[] : [];
			const mergedLocations = [...existingLocations, { name: `Location-${poiName}`, latitude, longitude }];

			const gpxItinBody: Record<string, unknown> = {
				...writableExisting,
				pois: mergedPois,
				locations: mergedLocations,
			};

			const itinResponse = await fetch(
				`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(referenceCode)}`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						"X-Operator-Code": OPERATOR_CODE,
						"X-User-Access-Token": env.VAMOOS_API_TOKEN,
					},
					body: JSON.stringify(gpxItinBody),
				},
			);

			const itinData = await safeJson(itinResponse);
			return new Response(
				JSON.stringify({ ok: itinResponse.ok, message: `GPX track "${poiName}" created as POI (id: ${poi.id}, ${waypoints.length} waypoints) and attached to trip.`, data: itinData }),
				{ status: itinResponse.ok ? 200 : itinResponse.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
			);
		}

		// Background image or document — upload to S3 then attach to itinerary
		const [existing, { url, s3url }] = await Promise.all([
			fetchItinerary(referenceCode, env.VAMOOS_API_TOKEN),
			getS3UploadUrl(filename, contentType, env.VAMOOS_API_TOKEN),
		]);
		await uploadToS3(url, fileData, contentType);

		// Spread all existing fields, then apply our change on top
		const itineraryBody: Record<string, unknown> = {
			...pickWritable(existing),
		};

		if (uploadType === "document") {
			itineraryBody.documents = buildDocumentsBody(existing, [{ file_url: s3url, name: documentName }]);
		} else {
			itineraryBody.background = { file_url: s3url, name: "Background Image" };
		}

		const vResponse = await fetch(
			`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(referenceCode)}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"X-Operator-Code": OPERATOR_CODE,
					"X-User-Access-Token": env.VAMOOS_API_TOKEN,
				},
				body: JSON.stringify(itineraryBody),
			},
		);

		const vData = await safeJson(vResponse);
		return new Response(JSON.stringify({ ok: vResponse.ok, s3url, data: vData }), {
			status: vResponse.ok ? 200 : vResponse.status,
			headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
		});
	} catch (err) {
		return new Response(
			JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
			{ status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
		);
	}
}

export class VamoosMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "Vamoos Itinerary Manager",
		version: "1.0.0",
	});

	async init() {
		// Create a new itinerary
		this.server.tool(
			"create_itinerary",
			"Create a new Vamoos trip/itinerary. The reference_code is shown as the Passcode in the app.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Unique reference code shown as the Passcode in the app (e.g. SmithRome25)"),
				departure_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Departure date (YYYY-MM-DD)"),
				return_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Return date (YYYY-MM-DD)"),
				field1: z
					.string()
					.max(128)
					.optional()
					.describe("Destination / Event Title (optional)"),
				field3: z
					.string()
					.max(128)
					.optional()
					.describe("Name / Location (optional)"),
			},
			async ({ reference_code, departure_date, return_date, field1, field3 }) => {
				const body: Record<string, unknown> = { departure_date, return_date };
				if (field1 !== undefined) body.field1 = field1;
				if (field3 !== undefined) body.field3 = field3;

				const response = await fetch(
					`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
							"X-Operator-Code": OPERATOR_CODE,
							"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
						},
						body: JSON.stringify(body),
					},
				);

				const data = await safeJson(response);

				if (!response.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}`,
							},
						],
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			},
		);

		// Update an existing itinerary
		this.server.tool(
			"update_itinerary",
			"Update an existing Vamoos trip/itinerary. Only supply the fields you want to change — all others are preserved automatically via an internal fetch-then-merge.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary to update"),
				departure_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.optional()
					.describe("New departure date (YYYY-MM-DD) — omit to keep existing"),
				return_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.optional()
					.describe("New return date (YYYY-MM-DD) — omit to keep existing"),
				field1: z
					.string()
					.max(128)
					.optional()
					.describe("Destination / Event Title — omit to keep existing"),
				field3: z
					.string()
					.max(128)
					.optional()
					.describe("Name / Location — omit to keep existing"),
			},
			async ({ reference_code, departure_date, return_date, field1, field3 }) => {
				const existing = await fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN);

				// Spread all existing fields so nothing is lost, then apply only the supplied overrides
				const body: Record<string, unknown> = { ...pickWritable(existing) };
				if (departure_date !== undefined) body.departure_date = departure_date;
				if (return_date !== undefined) body.return_date = return_date;
				if (field1 !== undefined) body.field1 = field1;
				if (field3 !== undefined) body.field3 = field3;

				const response = await fetch(
					`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
							"X-Operator-Code": OPERATOR_CODE,
							"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
						},
						body: JSON.stringify(body),
					},
				);

				const data = await safeJson(response);

				if (!response.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}`,
							},
						],
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			},
		);

		// List all itineraries
		this.server.tool(
			"list_itineraries",
			"List all Vamoos itineraries for the operator. Returns a summary of all trips including reference codes, dates, and vamoos_ids.",
			{
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number for pagination (default: 1)"),
				per_page: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Number of results per page (default: 50, max: 100)"),
			},
			async ({ page = 1, per_page = 50 }) => {
				const params = new URLSearchParams({
					page: String(page),
					per_page: String(per_page),
				});

				const response = await fetch(
					`${VAMOOS_BASE_URL}/itinerary?${params}`,
					{
						method: "GET",
						headers: {
							Accept: "application/json",
							"X-Operator-Code": OPERATOR_CODE,
							"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
						},
					},
				);

				const data = await safeJson(response);

				if (!response.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}`,
							},
						],
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			},
		);

		// Get a single itinerary by reference code
		this.server.tool(
			"get_itinerary",
			"Retrieve a single Vamoos itinerary by its reference code (Passcode). Returns full details including vamoos_id, dates, background, documents, and all fields.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("The reference code (Passcode) of the itinerary to retrieve"),
			},
			async ({ reference_code }) => {
				const response = await fetch(
					`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
					{
						method: "GET",
						headers: {
							Accept: "application/json",
							"X-Operator-Code": OPERATOR_CODE,
							"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
						},
					},
				);

				const data = await safeJson(response);

				if (!response.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}`,
							},
						],
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			},
		);

		// Upload a background image to an itinerary
		this.server.tool(
			"upload_background_image",
			"Upload a background image to a Vamoos itinerary. Provide the file as base64-encoded data. Trip metadata is fetched automatically — only the reference_code is needed to identify the trip.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				file_data: z
					.string()
					.describe("Base64-encoded image file data"),
				filename: z
					.string()
					.describe("Filename including extension (e.g. background.jpg)"),
				content_type: z
					.string()
					.describe("MIME type (e.g. image/jpeg, image/png)"),
			},
			async ({ reference_code, file_data, filename, content_type }) => {
				try {
					const [existing, { url, s3url }] = await Promise.all([
						fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN),
						getS3UploadUrl(filename, content_type, this.env.VAMOOS_API_TOKEN),
					]);

					await uploadToS3(url, base64ToBytes(file_data), content_type);

					// Spread all existing fields, then replace background
					const body: Record<string, unknown> = {
						...pickWritable(existing),
						background: { file_url: s3url, name: "Background Image" },
					};

					const response = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(body),
						},
					);

					const data = await safeJson(response);

					if (!response.ok) {
						return {
							content: [{ type: "text", text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}` }],
						};
					}

					return {
						content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
					};
				}
			},
		);

		// LEGACY: Upload AI-written markdown content as a PDF document to an itinerary.
		// Kept for reference — use upload_created_html_itinerary_document instead.
		this.server.tool(
			"legacy_upload_created_itinerary_document",
			"LEGACY TOOL — do not use. Use upload_created_html_itinerary_document instead. This tool converts markdown to PDF via Puppeteer and is no longer the preferred approach.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				document_name: z
					.string()
					.describe("Display name shown in the Vamoos app (e.g. 'Travel Itinerary', 'Welcome Letter')"),
				markdown_content: z
					.string()
					.describe("The full document written as plain markdown. Use # for the title, ## for headings, **bold**, and - for bullets. No HTML."),
			},
			async ({ reference_code, document_name, markdown_content }) => {
				try {
					const html = wrapHtmlIfNeeded(markdownToHtml(markdown_content), document_name);
					const fileBytes = await generatePdfFromHtml(html, this.env);
					const [existing, { url, s3url }] = await Promise.all([
						fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN),
						getS3UploadUrl("document.pdf", "application/pdf", this.env.VAMOOS_API_TOKEN),
					]);
					await uploadToS3(url, fileBytes, "application/pdf");

					const legacyBody: Record<string, unknown> = {
						...pickWritable(existing),
						documents: buildDocumentsBody(existing, [{ file_url: s3url, name: document_name }]),
					};

					const response = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(legacyBody),
						},
					);

					const data = await safeJson(response);

					if (!response.ok) {
						return {
							content: [{ type: "text", text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}` }],
						};
					}

					return {
						content: [{ type: "text", text: `Document "${document_name}" uploaded successfully.\n${JSON.stringify(data, null, 2)}` }],
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
					};
				}
			},
		);

		// Upload a GPX track file as a POI and attach it to an itinerary
		this.server.tool(
			"upload_gpx_and_attach_to_itinerary",
			"Upload a GPX track file to Vamoos as a Point of Interest (POI) and attach it to a trip. The track will appear on the map in the Vamoos app. Provide the raw GPX XML content and the original filename. Trip metadata is fetched automatically — only the reference_code is needed to identify the trip.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				gpx_content: z
					.string()
					.describe("Raw GPX XML content to upload"),
				filename: z
					.string()
					.describe("Original filename of the GPX file (e.g. mytrack.gpx), used as the POI name"),
			},
			async ({ reference_code, gpx_content, filename }) => {
				const log: string[] = [];
				try {
					// Parse waypoints from GPX
					const { latitude, longitude, waypoints } = parseGpx(gpx_content);
					const poiName = filename.replace(/\.gpx$/i, "");
					log.push(`[1/4] Parsed GPX: ${waypoints.length} waypoints, first point lat=${latitude} lon=${longitude}`);

					// Step 1: POST to /poi with JSON
					const poiPayload = {
						name: poiName,
						location: null,
						latitude,
						longitude,
						position: null,
						description: null,
						icon_id: 1,
						timezone: null,
						is_default_on: true,
						poi_range: 100,
						file: null,
						meta: { waypoints },
						type: "track",
						children: [],
						localisation: {},
					};
					log.push(`[2/4] POST ${VAMOOS_BASE_URL}/poi — payload (waypoints truncated): ${JSON.stringify({ ...poiPayload, meta: { waypoints: `[${waypoints.length} points]` } }, null, 2)}`);

					const poiResponse = await fetch(`${VAMOOS_BASE_URL}/poi`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
							"X-Operator-Code": OPERATOR_CODE,
							"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
						},
						body: JSON.stringify(poiPayload),
					});

					const poiData = await safeJson(poiResponse);
					log.push(`[2/4] POST /poi → HTTP ${poiResponse.status}\n${JSON.stringify(poiData, null, 2)}`);

					if (!poiResponse.ok) {
						return {
							content: [{ type: "text", text: `=== FAILED at step 2/4 (create POI) ===\n${log.join("\n\n")}` }],
						};
					}

					const poi = poiData as { id: number };
					log.push(`[3/4] POI created with id=${poi.id}`);

					// Step 2: Fetch existing itinerary, spread all fields, merge pois/locations
					const existing = await fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN);
					const writableExisting = pickWritable(existing);
					const locationName = `Location-${poiName}`;
					const mergedPois = mergePois(getExistingPois(existing), [{ id: poi.id, is_on: true }]);
					const existingLocations = Array.isArray(writableExisting.locations) ? writableExisting.locations as Record<string, unknown>[] : [];
					const mergedLocations = [...existingLocations, { name: locationName, latitude, longitude }];

					const itinPayload: Record<string, unknown> = {
						...writableExisting,
						pois: mergedPois,
						locations: mergedLocations,
					};

					log.push(`[4/4] POST ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)} — payload:\n${JSON.stringify({ ...itinPayload, pois: `[${mergedPois.length} pois]`, locations: `[${mergedLocations.length} locations]` }, null, 2)}`);

					const itinResponse = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(itinPayload),
						},
					);

					const itinData = await safeJson(itinResponse);
					log.push(`[4/4] POST /itinerary → HTTP ${itinResponse.status}\n${JSON.stringify(itinData, null, 2)}`);

					if (!itinResponse.ok) {
						return {
							content: [{ type: "text", text: `=== FAILED at step 4/4 (attach POI to itinerary) ===\n${log.join("\n\n")}` }],
						};
					}

					return {
						content: [{ type: "text", text: `=== SUCCESS ===\n${log.join("\n\n")}` }],
					};
				} catch (err) {
					log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
					return {
						content: [{ type: "text", text: `=== EXCEPTION ===\n${log.join("\n\n")}` }],
					};
				}
			},
		);

		// Add a POI (type=poi) and attach it to an itinerary
		this.server.tool(
			"add_poi_and_attach_to_itinerary",
			"Add a Point of Interest (POI) to Vamoos and attach it to a trip. The POI will appear on the map in the Vamoos app. Provide a name and coordinates. Trip metadata is fetched automatically — only the reference_code is needed to identify the trip.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				name: z
					.string()
					.describe("Display name for the POI"),
				latitude: z
					.string()
					.describe("Latitude of the POI (e.g. \"48.8566\")"),
				longitude: z
					.string()
					.describe("Longitude of the POI (e.g. \"2.3522\")"),
			},
			async ({ reference_code, name, latitude, longitude }) => {
				const log: string[] = [];
				try {
					// Step 1: POST to /poi with JSON
					const poiPayload = {
						name,
						location: null,
						latitude,
						longitude,
						position: null,
						description: null,
						icon_id: 1,
						timezone: null,
						is_default_on: true,
						poi_range: 100,
						file: null,
						meta: {},
						type: "poi",
						children: [],
						localisation: {},
					};
					log.push(`[1/3] POST ${VAMOOS_BASE_URL}/poi — payload:\n${JSON.stringify(poiPayload, null, 2)}`);

					const poiResponse = await fetch(`${VAMOOS_BASE_URL}/poi`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
							"X-Operator-Code": OPERATOR_CODE,
							"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
						},
						body: JSON.stringify(poiPayload),
					});

					const poiData = await safeJson(poiResponse);
					log.push(`[1/3] POST /poi → HTTP ${poiResponse.status}\n${JSON.stringify(poiData, null, 2)}`);

					if (!poiResponse.ok) {
						return {
							content: [{ type: "text", text: `=== FAILED at step 1/3 (create POI) ===\n${log.join("\n\n")}` }],
						};
					}

					const poi = poiData as { id: number };
					log.push(`[2/3] POI created with id=${poi.id}`);

					// Step 2: Fetch existing itinerary, spread all fields, merge pois/locations
					const existing = await fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN);
					const writableExisting = pickWritable(existing);
					const locationName = `Location-${name}`;
					const mergedPois = mergePois(getExistingPois(existing), [{ id: poi.id, is_on: true }]);
					const existingLocations = Array.isArray(writableExisting.locations) ? writableExisting.locations as Record<string, unknown>[] : [];
					const mergedLocations = [...existingLocations, { name: locationName, latitude, longitude }];

					const itinPayload: Record<string, unknown> = {
						...writableExisting,
						pois: mergedPois,
						locations: mergedLocations,
					};

					log.push(`[3/3] POST ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)} — payload:\n${JSON.stringify({ ...itinPayload, pois: `[${mergedPois.length} pois]`, locations: `[${mergedLocations.length} locations]` }, null, 2)}`);

					const itinResponse = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(itinPayload),
						},
					);

					const itinData = await safeJson(itinResponse);
					log.push(`[3/3] POST /itinerary → HTTP ${itinResponse.status}\n${JSON.stringify(itinData, null, 2)}`);

					if (!itinResponse.ok) {
						return {
							content: [{ type: "text", text: `=== FAILED at step 3/3 (attach POI to itinerary) ===\n${log.join("\n\n")}` }],
						};
					}

					return {
						content: [{ type: "text", text: `=== SUCCESS ===\n${log.join("\n\n")}` }],
					};
				} catch (err) {
					log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
					return {
						content: [{ type: "text", text: `=== EXCEPTION ===\n${log.join("\n\n")}` }],
					};
				}
			},
		);

		// Look up a flight and attach it to an itinerary via flight_ids
		this.server.tool(
			"add_flight_to_itinerary",
			"Look up a flight by carrier code, flight number, airports and date, then attach it to a Vamoos trip. Trip details (vamoos_id, dates) are fetched automatically — only the reference_code is needed to identify the trip. Carrier code and flight number may be given together (e.g. 'BA733') — split them before calling: carrier_code='BA', flight_number=733. Airports should be IATA codes (e.g. LHR, JFK) — use web_search to look them up if not provided. Existing flights on the trip are preserved.",
			{
				reference_code: z.string().min(1).max(64).describe("Reference code (Passcode) of the itinerary"),
				carrier_code: z.string().min(2).max(4).describe("Airline IATA (e.g. BA) or ICAO (e.g. BAW) code — letters only, no digits"),
				flight_number: z.number().int().positive().describe("Flight number — digits only, no carrier prefix (e.g. 733 for BA733)"),
				departure_airport: z.string().min(3).max(4).describe("IATA (e.g. LHR) or ICAO code of departure airport"),
				arrival_airport: z.string().min(3).max(4).describe("IATA (e.g. JFK) or ICAO code of arrival airport"),
				date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").describe("Date of flight departure (local time at departure airport), YYYY-MM-DD"),
			},
			async ({ reference_code, carrier_code, flight_number, departure_airport, arrival_airport, date }) => {
				const log: string[] = [];
				try {
					// Step 1: Look up flight
					const flightUrl = `${VAMOOS_BASE_URL}/flight/lookup/${encodeURIComponent(carrier_code)}/${flight_number}/${encodeURIComponent(departure_airport)}/${encodeURIComponent(arrival_airport)}/${date}`;
					log.push(`[1/3] GET ${flightUrl}`);
					const flightResponse = await fetch(flightUrl, {
						headers: {
							Accept: "application/json",
							"X-Operator-Code": OPERATOR_CODE,
							"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
						},
					});
					const flightData = await safeJson(flightResponse);
					log.push(`[1/3] GET /flight/lookup → HTTP ${flightResponse.status}\n${JSON.stringify(flightData, null, 2)}`);

					if (!flightResponse.ok) {
						return { content: [{ type: "text", text: `=== FAILED at step 1/3 (flight lookup) ===\n${log.join("\n\n")}` }] };
					}

					const flightLegs = Array.isArray(flightData) ? flightData : [];
					if (flightLegs.length === 0) {
						return { content: [{ type: "text", text: `=== FAILED at step 1/3 (no flights found) ===\n${log.join("\n\n")}` }] };
					}

					const flight = flightLegs[0] as { id: number; carrier_flight_number?: string; departure_at_utc?: string; arrival_at_utc?: string; status?: string };
					log.push(`[1/3] Found ${flightLegs.length} leg(s). Using first: id=${flight.id} ${flight.carrier_flight_number ?? ""} dep=${flight.departure_at_utc ?? ""} arr=${flight.arrival_at_utc ?? ""} status=${flight.status ?? ""}`);

					// Step 2: Fetch existing itinerary (fetch-then-merge)
					log.push(`[2/3] GET ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`);
					const existing = await fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN);
					const writableExisting = pickWritable(existing);
					const vamoos_id = existing.vamoos_id as number;
					const departure_date = existing.departure_date as string;
					const return_date = existing.return_date as string;

					// pickWritable already extracted existing flight_ids from the flights array
					const existingFlightIds = Array.isArray(writableExisting.flight_ids) ? writableExisting.flight_ids as number[] : [];
					const mergedFlightIds = existingFlightIds.includes(flight.id) ? existingFlightIds : [...existingFlightIds, flight.id];
					log.push(`[2/3] Fetched itinerary: vamoos_id=${vamoos_id} departure=${departure_date} return=${return_date}. Existing flight_ids=[${existingFlightIds.join(", ")}] → merged=[${mergedFlightIds.join(", ")}]`);

					// Step 3: POST itinerary with merged flight_ids
					const itinPayload: Record<string, unknown> = {
						...writableExisting,
						vamoos_id,
						departure_date,
						return_date,
						flight_ids: mergedFlightIds,
					};

					const poisSummary = Array.isArray(itinPayload.pois) ? `[${(itinPayload.pois as unknown[]).length} pois]` : itinPayload.pois;
					log.push(`[3/3] POST ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)} — payload:\n${JSON.stringify({ ...itinPayload, pois: poisSummary }, null, 2)}`);

					const itinResponse = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(itinPayload),
						},
					);

					const itinData = await safeJson(itinResponse);
					log.push(`[3/3] POST /itinerary → HTTP ${itinResponse.status}\n${JSON.stringify(itinData, null, 2)}`);

					if (!itinResponse.ok) {
						return { content: [{ type: "text", text: `=== FAILED at step 3/3 (attach flight to itinerary) ===\n${log.join("\n\n")}` }] };
					}

					return { content: [{ type: "text", text: `=== SUCCESS ===\n${log.join("\n\n")}` }] };
				} catch (err) {
					log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
					return { content: [{ type: "text", text: `=== EXCEPTION ===\n${log.join("\n\n")}` }] };
				}
			},
		);

		// Add a person (traveller) to an itinerary by name and email.
		// Uses fetch-then-merge: existing travellers are preserved; new entry is appended.
		// Deduplicates by email (case-insensitive).
		this.server.tool(
			"add_person_to_itinerary",
			"Add a person (traveller) to a Vamoos itinerary by name and email. Existing travellers are preserved. Duplicate emails (case-insensitive) are skipped.",
			{
				reference_code: z.string().min(1).max(64).describe("Reference code (Passcode) of the itinerary"),
				name: z.string().min(1).describe("Full name of the traveller (e.g. 'Ian Ball')"),
				email: z.string().email().describe("Email address of the traveller"),
			},
			async ({ reference_code, name, email }) => {
				const log: string[] = [];
				try {
					// Step 1: Fetch existing itinerary (fetch-then-merge)
					log.push(`[1/2] GET ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`);
					const existing = await fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN);
					const writableExisting = pickWritable(existing);
					const vamoos_id = existing.vamoos_id as number;

					// Extract already-stripped travellers from pickWritable output
					const existingTravellers = Array.isArray(writableExisting.travellers)
						? (writableExisting.travellers as Array<Record<string, unknown>>)
						: [];

					// Deduplicate by email (case-insensitive)
					const emailLower = email.toLowerCase();
					const duplicate = existingTravellers.find(
						t => typeof t.email === "string" && t.email.toLowerCase() === emailLower,
					);
					if (duplicate) {
						log.push(`[1/2] Traveller with email ${email} already exists — no change made.`);
						return { content: [{ type: "text", text: `=== SKIPPED (duplicate email) ===\n${log.join("\n\n")}` }] };
					}

					log.push(`[1/2] Fetched itinerary: vamoos_id=${vamoos_id}. Existing travellers: ${existingTravellers.length}. Adding: ${name} <${email}>`);

					// Step 2: POST with merged travellers
					const mergedTravellers = [...existingTravellers, { name, email }];
					const itinPayload: Record<string, unknown> = {
						...writableExisting,
						vamoos_id,
						travellers: mergedTravellers,
					};

					log.push(`[2/2] POST ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)} — travellers: ${JSON.stringify(mergedTravellers)}`);

					const itinResponse = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(itinPayload),
						},
					);

					const itinData = await safeJson(itinResponse);
					log.push(`[2/2] POST /itinerary → HTTP ${itinResponse.status}\n${JSON.stringify(itinData, null, 2)}`);

					if (!itinResponse.ok) {
						return { content: [{ type: "text", text: `=== FAILED at step 2/2 ===\n${log.join("\n\n")}` }] };
					}

					return { content: [{ type: "text", text: `=== SUCCESS ===\n${log.join("\n\n")}` }] };
				} catch (err) {
					log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
					return { content: [{ type: "text", text: `=== EXCEPTION ===\n${log.join("\n\n")}` }] };
				}
			},
		);

		// Add a standalone location to an itinerary (without a POI).
		// NOTE: POI tools already add a matching location automatically alongside each POI,
		// so this tool is NOT needed after adding a POI. Use it only when there is no POI
		// to add — e.g. a city or region the trip passes through — to make nearby global
		// Vamoos POIs visible for the trip. Locations appear on the trip map (separate tab
		// from POIs).
		this.server.tool(
			"add_location_to_itinerary",
			"Add a standalone location to a Vamoos trip (no POI). NOTE: POI tools already add a location automatically alongside each POI, so this tool is only needed when adding a location without a POI — e.g. to add a city or stopover so that nearby global Vamoos POIs become visible for the trip. Locations appear on the trip map in a separate tab from POIs. Only the reference_code is needed to identify the trip. Existing locations are preserved.",
			{
				reference_code: z.string().min(1).max(64).describe("Reference code (Passcode) of the itinerary"),
				name: z.string().min(1).max(128).describe("Display name for the location (e.g. 'Rome', 'Heathrow Airport')"),
				latitude: z.string().describe("Latitude (e.g. '41.9028')"),
				longitude: z.string().describe("Longitude (e.g. '12.4964')"),
				description: z.string().optional().describe("Optional description shown in the app"),
				icon_id: z.number().int().optional().describe("Optional icon ID"),
				position: z.number().int().min(0).optional().describe("Zero-based index at which to insert the location in the existing locations array. Omit to append at the end. Values past the array length are clamped to append."),
			},
			async ({ reference_code, name, latitude, longitude, description, icon_id, position }) => {
				const log: string[] = [];
				try {
					// Step 1: Fetch existing itinerary (fetch-then-merge)
					log.push(`[1/2] GET ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`);
					const existing = await fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN);
					const writableExisting = pickWritable(existing);
					const vamoos_id = existing.vamoos_id as number;
					const departure_date = existing.departure_date as string;
					const return_date = existing.return_date as string;

					const existingLocations = Array.isArray(writableExisting.locations) ? writableExisting.locations as Record<string, unknown>[] : [];
					const newLocation: Record<string, unknown> = { name, latitude, longitude };
					if (description !== undefined) newLocation.description = description;
					if (icon_id !== undefined) newLocation.icon_id = icon_id;
					const insertIdx = (position !== undefined && position <= existingLocations.length)
						? position
						: existingLocations.length;
					const mergedLocations = [
						...existingLocations.slice(0, insertIdx),
						newLocation,
						...existingLocations.slice(insertIdx),
					];

					log.push(`[1/2] Fetched itinerary: vamoos_id=${vamoos_id}. Existing locations=${existingLocations.length} → inserted at index ${insertIdx} → merged=${mergedLocations.length}`);

					// Step 2: POST itinerary with merged locations
					const itinPayload: Record<string, unknown> = {
						...writableExisting,
						vamoos_id,
						departure_date,
						return_date,
						locations: mergedLocations,
					};

					log.push(`[2/2] POST ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`);

					const itinResponse = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(itinPayload),
						},
					);

					const itinData = await safeJson(itinResponse);
					log.push(`[2/2] POST /itinerary → HTTP ${itinResponse.status}\n${JSON.stringify(itinData, null, 2)}`);

					if (!itinResponse.ok) {
						return { content: [{ type: "text", text: `=== FAILED at step 2/2 ===\n${log.join("\n\n")}` }] };
					}

					return { content: [{ type: "text", text: `=== SUCCESS ===\n${log.join("\n\n")}` }] };
				} catch (err) {
					log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
					return { content: [{ type: "text", text: `=== EXCEPTION ===\n${log.join("\n\n")}` }] };
				}
			},
		);

		// Add a location sourced from the Vamoos Connect venue database (see find_venues).
		// Identical fetch-then-merge flow to add_location_to_itinerary, but stamps the
		// location with meta.connect_id so it links back to the Connect venue record, and
		// uses the venue's address as the location description.
		this.server.tool(
			"add_venue_location_to_itinerary",
			"Add a Connect venue (hotel, B&B, villa, etc.) found via find_venues to a Vamoos trip as a map location. Pass the venue's name, coordinates and id (as connect_id) straight from the find_venues result; the venue address becomes the location description. The location is stamped with meta.connect_id so it links back to the Connect venue record. Uses fetch-then-merge — existing locations are preserved. Only the reference_code is needed to identify the trip.",
			{
				reference_code: z.string().min(1).max(64).describe("Reference code (Passcode) of the itinerary"),
				name: z.string().min(1).max(128).describe("Venue display name (from find_venues 'name')"),
				latitude: z.union([z.string(), z.number()]).transform(String).describe("Latitude (from find_venues 'latitude')"),
				longitude: z.union([z.string(), z.number()]).transform(String).describe("Longitude (from find_venues 'longitude')"),
				connect_id: z.string().uuid().describe("Connect venue id (from find_venues 'id') — stored as meta.connect_id to link the location to the venue record"),
				address: z.string().optional().describe("Venue address (from find_venues 'address') — shown as the location description"),
				position: z.number().int().min(0).optional().describe("Zero-based index at which to insert the location in the existing locations array. Omit to append at the end. Values past the array length are clamped to append."),
			},
			async ({ reference_code, name, latitude, longitude, connect_id, address, position }) => {
				const log: string[] = [];
				try {
					// Step 1: Fetch existing itinerary (fetch-then-merge)
					log.push(`[1/2] GET ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`);
					const existing = await fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN);
					const writableExisting = pickWritable(existing);
					const vamoos_id = existing.vamoos_id as number;
					const departure_date = existing.departure_date as string;
					const return_date = existing.return_date as string;

					const existingLocations = Array.isArray(writableExisting.locations) ? writableExisting.locations as Record<string, unknown>[] : [];
					const newLocation: Record<string, unknown> = { name, latitude, longitude, meta: { connect_id } };
					if (address !== undefined) newLocation.description = address;
					const insertIdx = (position !== undefined && position <= existingLocations.length)
						? position
						: existingLocations.length;
					const mergedLocations = [
						...existingLocations.slice(0, insertIdx),
						newLocation,
						...existingLocations.slice(insertIdx),
					];

					log.push(`[1/2] Fetched itinerary: vamoos_id=${vamoos_id}. Existing locations=${existingLocations.length} → inserted venue '${name}' (connect_id=${connect_id}) at index ${insertIdx} → merged=${mergedLocations.length}`);

					// Step 2: POST itinerary with merged locations
					const itinPayload: Record<string, unknown> = {
						...writableExisting,
						vamoos_id,
						departure_date,
						return_date,
						locations: mergedLocations,
					};

					log.push(`[2/2] POST ${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`);

					const itinResponse = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(itinPayload),
						},
					);

					const itinData = await safeJson(itinResponse);
					log.push(`[2/2] POST /itinerary → HTTP ${itinResponse.status}\n${JSON.stringify(itinData, null, 2)}`);

					if (!itinResponse.ok) {
						return { content: [{ type: "text", text: `=== FAILED at step 2/2 ===\n${log.join("\n\n")}` }] };
					}

					return { content: [{ type: "text", text: `=== SUCCESS ===\n${log.join("\n\n")}` }] };
				} catch (err) {
					log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
					return { content: [{ type: "text", text: `=== EXCEPTION ===\n${log.join("\n\n")}` }] };
				}
			},
		);

		// Upload an AI-generated HTML document directly as an .html file to an itinerary
		this.server.tool(
			"upload_created_html_itinerary_document",
			"ALWAYS use this tool when YOU (the assistant) are generating or writing any document content to attach to a Vamoos trip — for example itineraries, welcome letters, or information packs. Write the full document as HTML. The server uploads it as a .html file and attaches it to the trip. Do NOT use upload_document for AI-generated content. Trip metadata is fetched automatically — only the reference_code is needed to identify the trip.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				document_name: z
					.string()
					.describe("Display name shown in the Vamoos app (e.g. 'Travel Itinerary'). Also used as the filename."),
				html_content: z
					.string()
					.describe("The full document written as HTML. Can be a complete HTML document or a fragment — the server will wrap fragments automatically."),
			},
			async ({ reference_code, document_name, html_content }) => {
				try {
					const fullHtml = wrapHtmlIfNeeded(html_content, document_name);
					const fileBytes = new TextEncoder().encode(fullHtml);
					const safeFilename = document_name.replace(/[^a-zA-Z0-9 _-]/g, "").trim() + ".html";

					const [existing, { url, s3url }] = await Promise.all([
						fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN),
						getS3UploadUrl(safeFilename, "text/html", this.env.VAMOOS_API_TOKEN),
					]);
					await uploadToS3(url, fileBytes, "text/html");

					// Spread all existing fields, then merge documents
					const body: Record<string, unknown> = {
						...pickWritable(existing),
						documents: buildDocumentsBody(existing, [{ file_url: s3url, name: document_name }]),
					};

					const response = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(body),
						},
					);

					const data = await safeJson(response);

					if (!response.ok) {
						return {
							content: [{ type: "text", text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}` }],
						};
					}

					return {
						content: [{ type: "text", text: `Document "${document_name}" uploaded successfully as ${safeFilename}.\n${JSON.stringify(data, null, 2)}` }],
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
					};
				}
			},
		);

		// Upload a document to an itinerary — supports both HTML→PDF conversion and binary file upload
		this.server.tool(
			"upload_document",
			"Upload a user-supplied file to a Vamoos itinerary. Use this tool ONLY when the user has provided a file (base64 encoded) or raw HTML to upload — NOT when you are writing the document content yourself. For AI-generated documents use upload_created_html_itinerary_document instead. Two modes: (1) HTML→PDF: provide html_content with raw HTML to convert to PDF. (2) Binary file: provide file_data (base64) + filename + content_type. Trip metadata is fetched automatically — only the reference_code is needed to identify the trip.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				document_name: z
					.string()
					.describe("Display name shown in the app (e.g. Travel Itinerary)"),
				// Mode 1: HTML/text → PDF
				html_content: z
					.string()
					.optional()
					.describe("HTML, markdown, or plain text content to convert to PDF. Use this when you are writing the document yourself."),
				pdf_title: z
					.string()
					.optional()
					.describe("Title shown at the top of the generated PDF (used with html_content)"),
				// Mode 2: binary file upload
				file_data: z
					.string()
					.optional()
					.describe("Base64-encoded binary file data (for user-supplied files only)"),
				filename: z
					.string()
					.optional()
					.describe("Filename including extension (e.g. itinerary.pdf) — required when using file_data"),
				content_type: z
					.string()
					.optional()
					.describe("MIME type (e.g. application/pdf) — required when using file_data"),
			},
			async ({ reference_code, document_name, html_content, pdf_title, file_data, filename, content_type }) => {
				try {
					let fileBytes: Uint8Array;
					let uploadFilename: string;
					let uploadContentType: string;

					if (html_content) {
						// Mode 1: render HTML to PDF via browser
						const title = pdf_title ?? document_name;
						const fullHtml = wrapHtmlIfNeeded(html_content, title);
						fileBytes = await generatePdfFromHtml(fullHtml, this.env);
						uploadFilename = filename ?? "document.pdf";
						uploadContentType = "application/pdf";
					} else if (file_data) {
						// Mode 2: binary file supplied by the user
						fileBytes = base64ToBytes(file_data);
						uploadFilename = filename ?? "document.pdf";
						uploadContentType = content_type ?? "application/pdf";
					} else {
						return {
							content: [{ type: "text", text: "Error: provide either html_content (for generated content) or file_data (for a binary file)." }],
						};
					}

					const [existing, { url, s3url }] = await Promise.all([
						fetchItinerary(reference_code, this.env.VAMOOS_API_TOKEN),
						getS3UploadUrl(uploadFilename, uploadContentType, this.env.VAMOOS_API_TOKEN),
					]);
					await uploadToS3(url, fileBytes, uploadContentType);

					// Spread all existing fields, then merge documents
					const body: Record<string, unknown> = {
						...pickWritable(existing),
						documents: buildDocumentsBody(existing, [{ file_url: s3url, name: document_name }]),
					};

					const response = await fetch(
						`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}/${encodeURIComponent(reference_code)}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
								"X-Operator-Code": OPERATOR_CODE,
								"X-User-Access-Token": this.env.VAMOOS_API_TOKEN,
							},
							body: JSON.stringify(body),
						},
					);

					const data = await safeJson(response);

					if (!response.ok) {
						return {
							content: [{ type: "text", text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}` }],
						};
					}

					return {
						content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
					};
				}
			},
		);

		// Search the Vamoos Connect venue database (hotels, hostels, B&Bs, villas, etc.).
		// Uses the Connect API (connect.vamoos.com) with Bearer auth — different from the
		// legacy X-User-Access-Token used by the itinerary tools above.
		this.server.tool(
			"find_venues",
			"Search the Vamoos Connect venue database (hotels, hostels, B&Bs, villas, etc.). Returns matching venues with id, name, address, coordinates, star rating, classification and a short description. Supports free-text search, country, geographic radius, and facility/classification/star filters. All parameters are optional — call with no arguments to return the first page.",
			{
				query: z.string().optional().describe("Free-text search query (e.g. a venue name like 'London Hilton')"),
				country: z.string().length(2).optional().describe("ISO 3166 two-letter country code (e.g. GB, US, NO)"),
				latitude: z.number().min(-90).max(90).optional().describe("Latitude — use together with longitude and radius to limit the search geographically"),
				longitude: z.number().min(-180).max(180).optional().describe("Longitude — use together with latitude and radius to limit the search geographically"),
				radius: z.number().min(10).max(50000).optional().describe("Search radius in metres (10–50000). Must be used together with latitude and longitude"),
				has_images: z.boolean().optional().describe("When true, only return venues that have images"),
				in_portfolio: z.boolean().optional().describe("When true, only return venues in the current company's portfolio"),
				facilities: z.array(z.string().min(1)).optional().describe("Facility labels the venue must have (e.g. 'WiFi', 'Pool'). All listed facilities are required"),
				classifications: z
					.array(z.enum(["hotel", "hostel", "bed_and_breakfast", "villa", "non_accommodation"]))
					.optional()
					.describe("Venue accommodation types to include"),
				stars: z.array(z.number().int().min(1).max(5)).optional().describe("Star ratings to include (1–5)"),
				ids: z.array(z.string().uuid()).optional().describe("Restrict results to these venue IDs"),
				owner_id: z.string().uuid().optional().describe("Filter to venues owned by this company ID"),
				order_by: z.enum(["updatedAt"]).optional().describe("Column to order results by"),
				page: z.number().int().min(1).max(100).optional().describe("Page number for pagination (1-indexed, default 1)"),
				per_page: z.number().int().min(1).max(100).optional().describe("Results per page (1–100, default 10)"),
			},
			async ({ query, country, latitude, longitude, radius, has_images, in_portfolio, facilities, classifications, stars, ids, owner_id, order_by, page, per_page }) => {
				// Guard: the radius filter is only meaningful alongside a coordinate centre.
				if (radius !== undefined && (latitude === undefined || longitude === undefined)) {
					return { content: [{ type: "text", text: "Error: 'radius' must be used together with 'latitude' and 'longitude'." }] };
				}

				const params = new URLSearchParams();
				if (query !== undefined) params.set("q", query);
				if (country !== undefined) params.set("country", country);
				if (latitude !== undefined) params.set("lat", String(latitude));
				if (longitude !== undefined) params.set("lon", String(longitude));
				if (radius !== undefined) params.set("radius", String(radius));
				if (has_images !== undefined) params.set("hasImages", String(has_images));
				if (in_portfolio !== undefined) params.set("inPortfolio", String(in_portfolio));
				// Array filters use repeated query keys (style: form, explode: true).
				if (facilities !== undefined) for (const f of facilities) params.append("facilities", f);
				if (classifications !== undefined) for (const c of classifications) params.append("classifications", c);
				if (stars !== undefined) for (const s of stars) params.append("stars", String(s));
				if (ids !== undefined) for (const id of ids) params.append("ids", id);
				if (owner_id !== undefined) params.set("ownerId", owner_id);
				if (order_by !== undefined) params.set("orderBy", order_by);
				params.set("pageNumber", String(page ?? 1));
				params.set("pageSize", String(per_page ?? 10));

				const response = await fetch(`${CONNECT_BASE_URL}/venues?${params}`, {
					method: "GET",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${this.env.CONNECT_API_KEY}`,
						"x-operator-code": OPERATOR_CODE,
					},
				});

				const data = await safeJson(response);

				if (!response.ok) {
					return { content: [{ type: "text", text: `Error ${response.status}: ${JSON.stringify(data, null, 2)}` }] };
				}

				// Trim the payload to keep responses token-light: drop longDescription and raw image arrays.
				const result = data as { pageNumber?: number; pageSize?: number; hasMore?: boolean; items?: Array<Record<string, unknown>> };
				const items = Array.isArray(result.items) ? result.items : [];
				const summary = {
					pageNumber: result.pageNumber,
					pageSize: result.pageSize,
					hasMore: result.hasMore,
					count: items.length,
					venues: items.map(v => ({
						id: v.id,
						name: v.name,
						classification: v.classification,
						stars: v.stars,
						address: v.address,
						country: v.country,
						latitude: v.latitude,
						longitude: v.longitude,
						description: v.description,
						url: v.url,
						bookingUrl: v.bookingUrl,
						phone: v.phone,
						email: v.email,
						imageCount: Array.isArray(v.imageIds) ? v.imageIds.length : 0,
					})),
				};

				return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return VamoosMCP.serve("/mcp").fetch(request, env, ctx);
		}

		if (url.pathname === "/upload") {
			if (request.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}
			return handleUpload(request, env);
		}

		return new Response("Not found", { status: 404 });
	},
};
