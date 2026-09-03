import { initializeWebMCPPolyfill } from "@mcp-b/webmcp-polyfill";

// Keep this in sync with the exact dependency in package.json and web/package.json.
export const MCP_B_POLYFILL_VERSION = "5.1.0";

let initialized = false;

export function initializeStrictWebMcpPolyfill(): void {
  if (initialized) return;
  initializeWebMCPPolyfill();
  initialized = true;
}
