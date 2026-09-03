import type {
  ModelContextTool as StandardModelContextTool,
  ModelContextRegisterToolOptions,
} from "@mcp-b/webmcp-types";

export type ModelContextTool = StandardModelContextTool<Record<string, unknown>, unknown> & {
  inputSchema: Record<string, unknown>;
};

export interface ModelContextLike {
  registerTool(
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions,
  ): Promise<void> | void;
}

declare global {
  // Set by app bootstrap when the room Worker is on a different origin.
  var __MULTICOM_ROOM_WS_URL__: string | undefined;
}

export {};
