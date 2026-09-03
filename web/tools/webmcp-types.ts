export interface ToolExecuteOptions {
  signal: AbortSignal;
}

export interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (input: unknown, options: ToolExecuteOptions) => Promise<unknown>;
}

export interface ModelContextLike {
  registerTool(
    tool: ModelContextTool,
    options?: { signal?: AbortSignal },
  ): Promise<void> | void;
}

declare global {
  interface Document {
    readonly modelContext?: ModelContextLike;
  }

  interface Navigator {
    readonly modelContext?: ModelContextLike;
  }

  // Set by app bootstrap when the room Worker is on a different origin.
  var __MULTICOM_ROOM_WS_URL__: string | undefined;
}

export {};
