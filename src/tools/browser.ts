import type { Tool, ToolResult } from "./types.js";

const OPENCLAW_URL = process.env.OPENCLAW_BROWSER_URL ?? "";
const OPENCLAW_TOKEN = process.env.OPENCLAW_BROWSER_TOKEN ?? "";
const ACTION_TIMEOUT = 30_000;
const MAX_SNAPSHOT_CHARS = 50_000;
const MAX_SCREENSHOT_BYTES = 200_000;

const ALLOWED_INTERACT_VERBS = new Set([
  "click",
  "type",
  "press",
  "hover",
  "select",
  "fill",
  "drag",
  "scrollintoview",
  "highlight",
  "wait",
  "dialog",
]);

/** Invoke a browser tool action via OpenClaw Gateway's /tools/invoke API */
async function openclawBrowser(action: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (OPENCLAW_TOKEN) {
    headers["Authorization"] = `Bearer ${OPENCLAW_TOKEN}`;
  }

  const res = await fetch(`${OPENCLAW_URL}/tools/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tool: "browser",
      action: "json",
      args: { action },
    }),
    signal: AbortSignal.timeout(ACTION_TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenClaw ${res.status}: ${body}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok === false) {
    throw new Error(`OpenClaw error: ${JSON.stringify(json)}`);
  }
  const result = json.result;
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/** Block private/internal URLs to prevent SSRF */
function isPublicUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host)) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return false;
  if (host === "" || parsed.protocol === "file:") return false;
  return true;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[Truncated — ${text.length - max} chars omitted]`;
}

export const browsePage: Tool = {
  definition: {
    name: "browse_page",
    description:
      "Navigate to a URL and return the page content as an AI-readable text snapshot. " +
      "Use this to research URLs, verify websites, read documentation, or scrape page content. " +
      "Always call this before browser_interact — you need the element refs from the snapshot.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Full URL to navigate to (must be a public URL).",
        },
        wait_for: {
          type: "string",
          description: "Optional text to wait for on the page before taking the snapshot.",
        },
      },
      required: ["url"],
    },
  },
  async execute(input): Promise<ToolResult> {
    const url = input.url as string;
    if (!url) return { success: false, data: "Missing required field: url" };
    if (!isPublicUrl(url)) {
      return { success: false, data: `Blocked: ${url} is not a public URL (SSRF protection)` };
    }

    try {
      await openclawBrowser(`navigate ${url}`);

      if (input.wait_for) {
        const text = input.wait_for as string;
        await openclawBrowser(`wait --text "${text.replace(/"/g, '\\"')}"`);
      }

      const snapshot = await openclawBrowser("snapshot --format ai");
      return {
        success: true,
        data: truncate(snapshot, MAX_SNAPSHOT_CHARS),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: msg };
    }
  },
};

export const browserInteract: Tool = {
  definition: {
    name: "browser_interact",
    description:
      "Perform an interaction on the current browser page. Use element refs from a previous " +
      "browse_page snapshot. Supported actions: click, type, press, hover, select, fill, drag, " +
      "scrollintoview, wait, dialog. Returns the updated page snapshot after the action.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          description:
            'The action command to execute. Examples: \'click 12\', \'type 23 "hello"\', ' +
            "'press Enter', 'select 5 \"option1\"', 'fill --fields [{\"ref\":\"1\",\"type\":\"text\",\"value\":\"hello\"}]'",
        },
      },
      required: ["action"],
    },
  },
  async execute(input): Promise<ToolResult> {
    const action = (input.action as string)?.trim();
    if (!action) return { success: false, data: "Missing required field: action" };

    const verb = action.split(/\s+/)[0].toLowerCase();
    if (!ALLOWED_INTERACT_VERBS.has(verb)) {
      return {
        success: false,
        data: `Action "${verb}" is not allowed. Use one of: ${[...ALLOWED_INTERACT_VERBS].join(", ")}`,
      };
    }

    try {
      const actionResult = await openclawBrowser(action);
      const snapshot = await openclawBrowser("snapshot --format ai");
      return {
        success: true,
        data: `Action result:\n${actionResult}\n\nUpdated page:\n${truncate(snapshot, MAX_SNAPSHOT_CHARS)}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: msg };
    }
  },
};

export const browserScreenshot: Tool = {
  definition: {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of the current browser page. Returns base64-encoded image data. " +
      "Use for visual verification or to include screenshots in deliverables.",
    input_schema: {
      type: "object" as const,
      properties: {
        full_page: {
          type: "boolean",
          description: "Capture the full scrollable page instead of just the viewport. Default: false.",
        },
        ref: {
          type: "string",
          description: "Element ref from a snapshot to screenshot a specific element.",
        },
      },
      required: [],
    },
  },
  async execute(input): Promise<ToolResult> {
    const parts = ["screenshot"];
    if (input.full_page) parts.push("--full-page");
    if (input.ref) parts.push("--ref", String(input.ref));

    try {
      const result = await openclawBrowser(parts.join(" "));
      if (result.length > MAX_SCREENSHOT_BYTES) {
        return {
          success: true,
          data: result.slice(0, MAX_SCREENSHOT_BYTES) +
            `\n\n[Screenshot truncated — original ${result.length} bytes exceeded ${MAX_SCREENSHOT_BYTES} limit]`,
        };
      }
      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: msg };
    }
  },
};
