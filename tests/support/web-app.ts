import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WebApp {
  readonly origin: string;
  close(): Promise<void>;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForHttp(origin: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited early (${child.exitCode}).\n${output()}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The process has not bound its port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Vite did not become ready.\n${output()}`);
}

export async function startWebApp(roomServerOrigin: string): Promise<WebApp> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../..");
  const webRoot = join(root, "web");
  const requireFromWeb = createRequire(join(webRoot, "package.json"));
  const viteEntry = requireFromWeb.resolve("vite");
  const viteBin = join(resolve(dirname(viteEntry), "../.."), "bin", "vite.js");
  const port = await unusedPort();
  let output = "";
  const child = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: webRoot,
      env: { ...process.env, VITE_ROOM_WS_URL: roomServerOrigin },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  await waitForHttp(origin, child, () => output);
  return {
    origin,
    async close() {
      if (child.exitCode !== null) return;
      child.kill();
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
      ]);
    },
  };
}
