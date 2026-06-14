interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	/**
	 * Vamoos API token — set via: wrangler secret put VAMOOS_API_TOKEN
	 * This corresponds to the X-User-Access-Token header in API requests.
	 */
	VAMOOS_API_TOKEN: string;
	/**
	 * Vamoos Connect API key — set via: wrangler secret put CONNECT_API_KEY
	 * Sent as the `Authorization: Bearer <key>` header to connect.vamoos.com.
	 */
	CONNECT_API_KEY: string;
	BROWSER: Fetcher;
}
