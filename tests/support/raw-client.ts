import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/ws-messages";

export class RawClient {
  private readonly queue: ServerMessage[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.queue.push(message);
    });
  }

  static async connect(url: string): Promise<RawClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new RawClient(socket);
  }

  send(message: ClientMessage | Record<string, unknown> | string): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  async next(predicate: (message: ServerMessage) => boolean, timeoutMs = 2_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const existing = this.queue.findIndex(predicate);
      if (existing >= 0) return this.queue.splice(existing, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for matching protocol message.");
  }

  close(): void {
    this.socket.close();
  }
}
