/** Minimal JSON-RPC 2.0 request shape for the stdio MCP server. */
export interface JSONRPCRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
    [key: string]: unknown;
  };
}
