#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import fetch, { Response } from "node-fetch";

/**
 * Version of this library – update when publishing.
 */
export const VERSION = "0.1.0";

/**
 * Target MediaWiki API endpoint (defaults to test2.wikipedia.org).
 * Can be overridden via the WIKI_API_ENDPOINT environment variable.
 */
const WIKI_API_ENDPOINT =
  process.env.WIKI_API_ENDPOINT ?? "https://test2.wikipedia.org/w/api.php";

/* -------------------------------------------------------------------------
 * Zod Schemas & Types
 * ---------------------------------------------------------------------- */
/**
 * Schema for the `edit_page` tool. Either `text` or `appendtext` must be
 * provided.
 */
const EditPageSchema = z
  .object({
    title: z.string().describe("Page title to edit or create"),
    text: z.string().optional().describe("Full wikitext replacement"),
    appendtext: z
      .string()
      .optional()
      .describe("Text to append to the existing page content"),
    summary: z
      .string()
      .optional()
      .default("Edit via MCP")
      .describe("Edit summary (edit comment)"),
    username: z
      .string()
      .optional()
      .describe(
        "Optional username for login. If omitted, the edit is anonymous (if allowed)."
      ),
    password: z
      .string()
      .optional()
      .describe("Password corresponding to the username."),
  })
  .refine((d) => d.text || d.appendtext, {
    message: "Either `text` or `appendtext` must be supplied.",
    path: ["text"],
  });

export type EditPageArgs = z.infer<typeof EditPageSchema>;

/* -------------------------------------------------------------------------
 * Minimal Cookie Jar helper
 * ---------------------------------------------------------------------- */
class CookieJar {
  private jar: Record<string, string> = {};

  /** Store cookies from a fetch Response */
  public store(response: Response): void {
    const raw = response.headers.get("set-cookie");
    if (!raw) return;
    // Multiple cookies may be returned separated by comma when using HTTP/2.
    const parts = raw.split(/,(?=[^;]+=[^;]+)/g);
    for (const part of parts) {
      const [cookiePair] = part.split(";");
      if (!cookiePair) continue; // skip malformed part

      const eqIndex = cookiePair.indexOf("=");
      if (eqIndex === -1) continue; // skip if no '=' found

      const name = cookiePair.slice(0, eqIndex).trim();
      const value = cookiePair.slice(eqIndex + 1).trim();
      if (!name) continue; // skip if name is empty
      // Value may be empty (e.g., flag cookies); store only if defined
      this.jar[name] = value ?? "";
    }
  }

  /** Serialize cookies for a request */
  public toHeader(): string | undefined {
    const entries = Object.entries(this.jar);
    return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }
}

/* -------------------------------------------------------------------------
 * MediaWiki helpers
 * ---------------------------------------------------------------------- */
/**
 * Perform login if `username` and `password` are provided. Returns the updated
 * CookieJar ready for authenticated requests.
 */
async function loginIfNecessary(
  cookieJar: CookieJar,
  username?: string,
  password?: string
): Promise<void> {
  if (!username || !password) {
    return; // anonymous edit path
  }

  // Step 1: obtain login token
  const tokenUrl = `${WIKI_API_ENDPOINT}?action=query&meta=tokens&type=login&format=json`;
  const tokenResp = await fetch(tokenUrl, {
    headers: {
      Cookie: cookieJar.toHeader() ?? "",
    },
  });
  cookieJar.store(tokenResp);
  const tokenJson = (await tokenResp.json()) as any;
  const loginToken: string | undefined = tokenJson?.query?.tokens?.logintoken;
  if (!loginToken) {
    throw new Error("Failed to obtain login token from MediaWiki API.");
  }

  // Step 2: POST login credentials
  const body = new URLSearchParams();
  body.append("action", "login");
  body.append("lgname", username);
  body.append("lgpassword", password);
  body.append("lgtoken", loginToken);
  body.append("format", "json");

  const loginResp = await fetch(WIKI_API_ENDPOINT, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieJar.toHeader() ?? "",
    },
  });
  cookieJar.store(loginResp);
  const loginResult = (await loginResp.json()) as any;
  if (loginResult?.login?.result !== "Success") {
    throw new Error(`MediaWiki login failed: ${loginResult?.login?.result}`);
  }
}

/**
 * Obtain a CSRF token (requires prior login for non-anonymous edits).
 */
async function getCsrfToken(cookieJar: CookieJar): Promise<string> {
  const url = `${WIKI_API_ENDPOINT}?action=query&meta=tokens&type=csrf&format=json`;
  const resp = await fetch(url, {
    headers: {
      Cookie: cookieJar.toHeader() ?? "",
    },
  });
  cookieJar.store(resp);
  const json = (await resp.json()) as any;
  const token: string | undefined = json?.query?.tokens?.csrftoken;
  if (!token) {
    throw new Error("Failed to retrieve CSRF token from MediaWiki API.");
  }
  return token;
}

/**
 * Execute an `action=edit` request and return the raw API response JSON.
 */
async function performEdit(args: EditPageArgs): Promise<any> {
  const cookieJar = new CookieJar();
  // Optional login
  await loginIfNecessary(cookieJar, args.username, args.password);
  // Determine CSRF token
  const csrfToken = await getCsrfToken(cookieJar);

  // Build POST payload
  const payload = new URLSearchParams();
  payload.append("action", "edit");
  payload.append("title", args.title);
  if (args.text) payload.append("text", args.text);
  if (args.appendtext) payload.append("appendtext", args.appendtext);
  payload.append("format", "json");
  payload.append("token", csrfToken);
  payload.append("summary", args.summary ?? "Edit via MCP");

  const editResp = await fetch(WIKI_API_ENDPOINT, {
    method: "POST",
    body: payload,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieJar.toHeader() ?? "",
    },
  });
  cookieJar.store(editResp);
  const result = await editResp.json();
  return result;
}

/* -------------------------------------------------------------------------
 * MCP Server setup
 * ---------------------------------------------------------------------- */
const server = new Server(
  {
    name: "wikipedia-mcp-server",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "edit_page",
        description:
          "Create or update a page on test2.wikipedia.org via the MediaWiki Action API.",
        inputSchema: zodToJsonSchema(EditPageSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!request.params.arguments) {
    throw new Error("Arguments are required for tool invocation.");
  }

  switch (request.params.name) {
    case "edit_page": {
      const args = EditPageSchema.parse(request.params.arguments);
      const result = await performEdit(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

async function main(): Promise<void> {
  // Ensure global fetch (for Node < 18)
  if (!globalThis.fetch) {
    (globalThis as any).fetch = fetch;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Wikipedia MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
}); 