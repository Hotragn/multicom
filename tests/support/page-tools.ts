import { expect, type Page } from "@playwright/test";
import { TOOL_NAMES } from "../../shared/tools";

declare global {
  interface Window {
    __multicomTools?: Record<string, {
      name: string;
      description: string;
      annotations?: Record<string, boolean>;
      execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown>;
    }>;
  }
}

export async function installWebMcpCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools: NonNullable<Window["__multicomTools"]> = {};
    window.__multicomTools = tools;
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: NonNullable<Window["__multicomTools"]>[string]) {
          tools[tool.name] = tool;
        },
      },
    });
  });
}

export async function waitForTools(page: Page): Promise<void> {
  // From the contract, not a literal: a thirteenth tool should not need a
  // grep across the suite to be believed.
  await expect
    .poll(() => page.evaluate(() => Object.keys(window.__multicomTools ?? {}).length))
    .toBe(TOOL_NAMES.length);
}

export async function callTool<T = unknown>(page: Page, name: string, input: unknown): Promise<T> {
  return page.evaluate(async ({ toolName, args }) => {
    const tool = window.__multicomTools?.[toolName];
    if (!tool) throw new Error(`Tool ${toolName} is not registered.`);
    return tool.execute(args, { signal: new AbortController().signal });
  }, { toolName: name, args: input }) as Promise<T>;
}

export async function openRoom(
  page: Page,
  appOrigin: string,
  room: string,
  demo = false,
  commanderToken?: string,
): Promise<void> {
  await installWebMcpCapture(page);
  const query = new URLSearchParams({ room });
  if (demo) query.set("demo", "1");
  if (commanderToken) query.set("commander", commanderToken);
  await page.goto(`${appOrigin}/?${query.toString()}`);
  await waitForTools(page);
}
