/**
 * `@ractive-ch/tab-mcp-client`: offer a web page's tools to AI apps through a
 * tab-mcp relay. This entry is the small core; `connect()` loads the rest.
 */

export { TabMcp } from "./tab-mcp.ts";
export type {
	ConfirmHandler,
	ConfirmRequest,
	ConnectionState,
	ConnectOptions,
	DisconnectDetail,
	DisconnectReason,
	Grant,
	JsonSchema,
	Limits,
	PairingCode,
	RegisterToolOptions,
	SecretStorage,
	ServerInfo,
	SessionInfo,
	TabMcpEventMap,
	TabMcpOptions,
	Tool,
	ToolAnnotations,
	ToolCallClient,
	ToolExecuteOptions,
} from "./types.ts";
export { VERSION } from "./version.ts";
