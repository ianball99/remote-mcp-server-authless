import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
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
		const data = await response.json();
		throw new Error(`Failed to get S3 upload URL: ${JSON.stringify(data)}`);
	}
	return response.json() as Promise<{ url: string; s3url: string }>;
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

				const data = await response.json();

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

				const data = await response.json();

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

					const data = await response.json();

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
			"Upload a document to a Vamoos itinerary's travel documents. Provide the file as base64-encoded data.",
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

					const data = await response.json();

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

		return new Response("Not found", { status: 404 });
	},
};
