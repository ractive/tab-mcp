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
	IdentityAssertionHandler,
	IdentityAssertionRequest,
	IdentityState,
	JsonSchema,
	Limits,
	PairingCode,
	ReconnectingInfo,
	ReconnectOptions,
	RegisterToolOptions,
	ReplacedDetail,
	SecretStorage,
	ServerInfo,
	SessionInfo,
	TabMcpEventMap,
	TabMcpOptions,
	Tool,
	ToolAnnotations,
	ToolCallClient,
	ToolCallEnd,
	ToolCallOutcome,
	ToolCallResult,
	ToolCallStart,
	ToolExecuteOptions,
} from "./types.ts";
export { VERSION } from "./version.ts";
