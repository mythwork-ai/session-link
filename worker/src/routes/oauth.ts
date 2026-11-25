import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { ensureAuthor, githubAuthorizeUrl, signInWithGithub } from "../auth/github";
import { HttpError } from "../http";
import { escapeHtml } from "../web/session";
import { render } from "../web/ui";

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

// Consent and error pages share the site shell. The library's consent headers (no framing,
// browser-bound cookie) are kept: render() only adds to the headers it's given.
// No form-action rule here: Allow and Deny redirect to GitHub or back to the client, and
// Chrome applies form-action to redirects after a form post. Framing stays blocked.
export const CONSENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const html = (body: string, headers = new Headers(), status = 200) =>
  render({ title: "Connect", headers, status, csp: CONSENT_CSP, body: `<div class="center"><section class="card state">${body}</section></div>` });

/** MCP authorization: consent for this client, then GitHub sign-in, then org-membership check. */
export async function authorize(req: Request, env: OAuthEnv, now: number): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const path = new URL(req.url).pathname;
    if (path === "/authorize" && req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const d = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      const origin = d.clientDomain ? `Published by <strong>${escapeHtml(d.clientDomain)}</strong>.` : "This app registered itself; its name is not verified.";
      return html(
        `<h1 style="font-size:22px">Connect ${escapeHtml(d.clientName)} to session-link?</h1>
<p class="calm">${origin} Access goes to <strong style="color:var(--text)">${escapeHtml(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="notice bad">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<p class="calm">It will be able to read team status and, if your role allows, post updates as you. You'll sign in with GitHub next.</p>
<form method="post" style="display:flex;gap:12px"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
<button class="btn primary" name="decision" value="approve">Allow</button><button class="btn" name="decision" value="deny">Deny</button></form>`,
        consent.headers,
      );
    }
    if (path === "/authorize" && req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle);
      const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers });
      headers.set("location", githubAuthorizeUrl(env, state, "/callback"));
      return new Response(null, { status: 302, headers });
    }
    // GET /callback
    const { request: original, headers } = await oauth.finishUpstream(req);
    const params = new URL(req.url).searchParams;
    if (params.get("error") || !params.get("code")) {
      headers.set("location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    let who;
    try {
      who = await signInWithGithub(env, params.get("code")!, "/callback");
      await ensureAuthor(env, who, now);
    } catch (e) {
      // Not a member, revoked, or GitHub failed: answer the waiting MCP client instead of stranding it.
      if (!(e instanceof HttpError)) throw e;
      console.error(JSON.stringify({ msg: "mcp sign-in refused", code: e.code, error: e.message }));
      headers.set("location", authorizationErrorRedirect(original, "access_denied", e.message));
      return new Response(null, { status: 302, headers });
    }
    const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: who.login, metadata: {}, scope: original.scope, props: { login: who.login } });
    headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      return html(`<h1 style="font-size:22px">Couldn't connect</h1><p class="calm">${escapeHtml(e instanceof AuthorizationError ? e.description : "This app could not be verified.")}</p><p class="calm small">Start the connection again from Claude.</p>`, new Headers(), 400);
    }
    if (e instanceof HttpError) return html(`<h1 style="font-size:22px">Couldn't connect</h1><p class="calm">${escapeHtml(e.message)}</p>`, new Headers(), e.status);
    throw e;
  }
}
