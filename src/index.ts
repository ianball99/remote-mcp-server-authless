import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";

const VAMOOS_BASE_URL = "https://live.vamoos.com/v3";
const OPERATOR_CODE = "alisdair";

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

function htmlToText(html: string): string {
	return html
		// Remove <style> and <script> blocks entirely (tags + content)
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		// Convert block elements to newlines before stripping
		.replace(/<h[1-3][^>]*>/gi, "\n## ")
		.replace(/<\/h[1-6]>/gi, "\n")
		.replace(/<(p|div|li|tr|br\s?\/?)[^>]*>/gi, "\n")
		.replace(/<\/?(ul|ol|table|thead|tbody)[^>]*>/gi, "\n")
		// Strip all remaining tags
		.replace(/<[^>]+>/g, "")
		// Decode common HTML entities
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		// Collapse multiple blank lines
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function generatePdfFromText(title: string, content: string): Promise<Uint8Array> {
	// Strip HTML if the content looks like an HTML document
	if (/<html[\s>]/i.test(content) || /<!doctype\s+html/i.test(content)) {
		content = htmlToText(content);
	}
	const pdfDoc = await PDFDocument.create();
	const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

	const pageWidth = 595;
	const pageHeight = 842;
	const marginX = 50;
	const marginY = 50;
	const contentWidth = pageWidth - 2 * marginX;

	let page = pdfDoc.addPage([pageWidth, pageHeight]);
	let y = pageHeight - marginY;

	const titleSize = 16;
	page.drawText(title, { x: marginX, y: y - titleSize, size: titleSize, font: boldFont, color: rgb(0, 0, 0) });
	y -= titleSize + 6;
	page.drawLine({ start: { x: marginX, y }, end: { x: pageWidth - marginX, y }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
	y -= 14;

	const bodySize = 10;
	const lineHeight = bodySize * 1.6;
	const headingSize = 12;

	const drawLine = (text: string, size: number, f: typeof font) => {
		if (y - size < marginY) {
			page = pdfDoc.addPage([pageWidth, pageHeight]);
			y = pageHeight - marginY;
		}
		if (text) page.drawText(text, { x: marginX, y, size, font: f, color: rgb(0, 0, 0) });
		y -= size * 1.6;
	};

	for (const rawLine of content.split("\n")) {
		const isHeading = /^#{1,3}\s/.test(rawLine);
		const lineText = rawLine.replace(/^#{1,3}\s*/, "").replace(/\*\*(.*?)\*\*/g, "$1");
		const size = isHeading ? headingSize : bodySize;
		const f = isHeading ? boldFont : font;

		if (!lineText.trim()) {
			y -= lineHeight * 0.5;
			continue;
		}

		// Word-wrap
		const words = lineText.split(" ");
		let current = "";
		for (const word of words) {
			const test = current ? `${current} ${word}` : word;
			if (f.widthOfTextAtSize(test, size) > contentWidth && current) {
				drawLine(current, size, f);
				current = word;
			} else {
				current = test;
			}
		}
		if (current) drawLine(current, size, f);
	}

	return pdfDoc.save();
}

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

		const vamoosId = Number(formData.get("vamoos_id") || 0);
		const referenceCode = String(formData.get("reference_id") || formData.get("reference_code") || "");
		const departureDate = String(formData.get("departure_date") || "");
		const returnDate = String(formData.get("return_date") || "");
		const filename = String(formData.get("image_filename") || file.name);
		const contentType = String(formData.get("image_content_type") || file.type || "application/octet-stream");
		const uploadType = String(formData.get("upload_type") || "background");
		const documentName = String(formData.get("document_name") || "Document");

		if (!referenceCode || !departureDate || !returnDate) {
			return new Response(
				JSON.stringify({ error: "Missing required fields: reference_id, departure_date, return_date" }),
				{ status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
			);
		}

		const { url, s3url } = await getS3UploadUrl(filename, contentType, env.VAMOOS_API_TOKEN);
		const fileData = new Uint8Array(await file.arrayBuffer());
		await uploadToS3(url, fileData, contentType);

		const itineraryBody: Record<string, unknown> = {
			vamoos_id: vamoosId,
			departure_date: departureDate,
			return_date: returnDate,
		};

		if (uploadType === "document") {
			itineraryBody.documents = { travel: [{ file_url: s3url, name: documentName }] };
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
			"Update an existing Vamoos trip/itinerary. Requires the vamoos_id which stays constant across updates.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary to update"),
				vamoos_id: z
					.number()
					.int()
					.describe("The vamoos_id of the itinerary — stays constant across all updates"),
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
			async ({ reference_code, vamoos_id, departure_date, return_date, field1, field3 }) => {
				const body: Record<string, unknown> = { vamoos_id, departure_date, return_date };
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
					`${VAMOOS_BASE_URL}/itinerary/${OPERATOR_CODE}?${params}`,
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
			"Upload a background image to a Vamoos itinerary. Provide the file as base64-encoded data.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				vamoos_id: z
					.number()
					.int()
					.describe("The vamoos_id of the itinerary"),
				departure_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Departure date (YYYY-MM-DD)"),
				return_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Return date (YYYY-MM-DD)"),
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
			async ({ reference_code, vamoos_id, departure_date, return_date, file_data, filename, content_type }) => {
				try {
					const { url, s3url } = await getS3UploadUrl(filename, content_type, this.env.VAMOOS_API_TOKEN);

					await uploadToS3(url, base64ToBytes(file_data), content_type);

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
							body: JSON.stringify({
								vamoos_id,
								departure_date,
								return_date,
								background: {
									file_url: s3url,
									name: "Background Image",
								},
							}),
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

		// Generate a PDF from text and upload it as a travel document
		this.server.tool(
			"generate_and_upload_pdf",
			"Generate a PDF from plain text content and upload it as a travel document to a Vamoos itinerary. Use this instead of upload_document when you want to create a PDF itinerary — pass the itinerary text directly and a proper PDF will be generated server-side.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				vamoos_id: z
					.number()
					.int()
					.describe("The vamoos_id of the itinerary"),
				departure_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Departure date (YYYY-MM-DD)"),
				return_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Return date (YYYY-MM-DD)"),
				title: z
					.string()
					.describe("Title displayed at the top of the PDF (e.g. 'Rome Trip Itinerary')"),
				content: z
					.string()
					.describe("Plain text or markdown content of the itinerary. Supports # headings and **bold** text."),
				filename: z
					.string()
					.optional()
					.describe("Filename for the PDF (default: itinerary.pdf)"),
				document_name: z
					.string()
					.describe("Display name shown in the app (e.g. Travel Itinerary)"),
			},
			async ({ reference_code, vamoos_id, departure_date, return_date, title, content, filename = "itinerary.pdf", document_name }) => {
				try {
					const pdfBytes = await generatePdfFromText(title, content);

					const { url, s3url } = await getS3UploadUrl(filename, "application/pdf", this.env.VAMOOS_API_TOKEN);
					await uploadToS3(url, pdfBytes, "application/pdf");

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
							body: JSON.stringify({
								vamoos_id,
								departure_date,
								return_date,
								documents: {
									travel: [{ file_url: s3url, name: document_name }],
								},
							}),
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

		// Upload a document to an itinerary
		this.server.tool(
			"upload_document",
			"Upload a document to a Vamoos itinerary's travel documents. Provide the file as base64-encoded data. IMPORTANT: If you want to upload a PDF itinerary you wrote as text, use generate_and_upload_pdf instead — this tool is for uploading pre-existing binary files only.",
			{
				reference_code: z
					.string()
					.min(1)
					.max(64)
					.describe("Reference code (Passcode) of the itinerary"),
				vamoos_id: z
					.number()
					.int()
					.describe("The vamoos_id of the itinerary"),
				departure_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Departure date (YYYY-MM-DD)"),
				return_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
					.describe("Return date (YYYY-MM-DD)"),
				file_data: z
					.string()
					.describe("Base64-encoded document file data"),
				filename: z
					.string()
					.describe("Filename including extension (e.g. itinerary.pdf)"),
				content_type: z
					.string()
					.describe("MIME type (e.g. application/pdf)"),
				document_name: z
					.string()
					.describe("Display name shown in the app (e.g. Travel Itinerary)"),
			},
			async ({ reference_code, vamoos_id, departure_date, return_date, file_data, filename, content_type, document_name }) => {
				try {
					let fileBytes = base64ToBytes(file_data);

					// If the caller claims this is a PDF but the bytes aren't a real PDF
					// (e.g. Claude passed base64-encoded text/HTML), auto-convert to a proper PDF.
					const isPdf = content_type === "application/pdf";
					const hasPdfHeader = fileBytes.length > 4 &&
						fileBytes[0] === 0x25 && fileBytes[1] === 0x50 &&
						fileBytes[2] === 0x44 && fileBytes[3] === 0x46; // %PDF
					if (isPdf && !hasPdfHeader) {
						const text = new TextDecoder().decode(fileBytes);
						fileBytes = await generatePdfFromText(document_name, text);
					}

					const { url, s3url } = await getS3UploadUrl(filename, content_type, this.env.VAMOOS_API_TOKEN);

					await uploadToS3(url, fileBytes, content_type);

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
							body: JSON.stringify({
								vamoos_id,
								departure_date,
								return_date,
								documents: {
									travel: [
										{
											file_url: s3url,
											name: document_name,
										},
									],
								},
							}),
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
