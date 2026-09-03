import type {
  ModelContextTool as StandardModelContextTool,
  ModelContextRegisterToolOptions,
} from "@mcp-b/webmcp-types";

export type ModelContextTool = StandardModelContextTool<Record<string, unknown>, unknown> & {
  inputSchema: Record<string, unknown>;
  /**
   * The exact result envelope, so a client never has to guess whether the
   * payload sits under `status`, `result`, or `lines`.
   *
   * An MCP-B extension, not part of the standard `ModelContextTool`
   * dictionary: Chrome's native surface drops it, and `getTools()` there
   * returns none of the twelve carrying one. Publishing it costs nothing and
   * helps clients that do read it, but the tool *description* is what actually
   * reaches an agent — which is why the descriptions name the envelope too.
   */
  outputSchema?: Record<string, unknown>;
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
