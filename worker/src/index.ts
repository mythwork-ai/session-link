import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { errorResponse, HttpError, json } from "./http";
import { mcpHandler } from "./mcp/server";
import { admin } from "./routes/admin";
import { authorize } from "./routes/oauth";
import { web } from "./routes/web";
import { githubWebhook } from "./routes/webhook";
import { runDaily } from "./jobs/daily";

async function route(req: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const path = new URL(req.url).pathname;
  const key = `${req.method} ${path}`;
  if (key === "GET /v1/health") {
    await env.LEDGER_DB.prepare("SELECT 1").first();
    return json({ ok: true });
  }
  if (key === "POST /v1/gh") return githubWebhook(env, req, now);
  if (path.startsWith("/v1/admin/")) return admin(env, req, path, now);
  if (path === "/authorize" || key === "GET /callback") return authorize(req, env as Env & { OAUTH_PROVIDER: OAuthHelpers }, now);
  const page = await web(env, req, path, now);
  if (page) return page;
  throw new HttpError(404, "not_found", `no route ${key}`);
}

const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
};

// The provider needs the public URL for its resource metadata, which only exists on env.
let provider: { url: string; p: OAuthProvider<Env> } | undefined;
function oauth(env: Env): OAuthProvider<Env> {
  const url = env.PUBLIC_URL ?? "";
  if (!/^(https:\/\/[^/]+|http:\/\/localhost(:\d+)?)$/.test(url) || url.includes("REPLACE")) {
    throw new Error(`PUBLIC_URL must be the Worker's https origin with no trailing slash; got "${url}"`);
  }
  if (provider?.url !== env.PUBLIC_URL) {
    provider = {
      url: env.PUBLIC_URL,
      p: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpHandler as never,
        defaultHandler: defaultHandler as never,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: ["ledger"],
        requiredScopes: ["ledger"],
        resourceMetadata: { resource: `${env.PUBLIC_URL}/mcp`, authorization_servers: [env.PUBLIC_URL] },
      }),
    };
  }
  return provider.p;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The old workers.dev address forwards to the public host, so links and bookmarks keep working.
    const url = new URL(req.url);
    if (url.hostname.endsWith(".workers.dev") && url.pathname !== "/v1/gh" && env.PUBLIC_URL && !env.PUBLIC_URL.includes(url.hostname)) {
      return Response.redirect(`${env.PUBLIC_URL}${url.pathname}${url.search}`, 308);
    }
    return oauth(env).fetch(req, env, ctx);
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([runDaily(env, Date.now()), oauth(env).purgeExpiredData(env)]));
  },
} satisfies ExportedHandler<Env>;
