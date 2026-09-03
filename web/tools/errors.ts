export class ToolInputError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid_input") {
    super(message);
    this.name = "ToolInputError";
    this.code = code;
  }
}

export class RoomClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RoomClientError";
    this.code = code;
  }
}

export function abortError(message = "The tool call was cancelled."): Error {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}
