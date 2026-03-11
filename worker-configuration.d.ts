interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	/**
	 * Vamoos API token — set via: wrangler secret put VAMOOS_API_TOKEN
	 * This corresponds to the X-User-Access-Token header in API requests.
	 */
	VAMOOS_API_TOKEN: string;
}
