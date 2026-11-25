import { escapeHtml } from "./session";

// One shell for every page. Colors are CSS variables that follow the viewer's light/dark
// setting, so text always has contrast. System fonts only: the CSP allows no outside requests.
const CSS = `
:root{color-scheme:light dark;--bg:#F6F7F9;--surface:#FFFFFF;--line:#DDE1E7;--text:#1A1D23;--muted:#5C6370;--chip:#E8EBF0;
--accent:#2457C5;--accent-soft:#EEF3FD;--accent-text:#1D4BAD;--on-accent:#FFFFFF;--warn-bg:#FDF0E4;--warn-fg:#9A4A0C;--warn-line:#EDC8A4;
--ok-bg:#EAF6EF;--ok-fg:#1E6B42;--ok-line:#B9DFC8;--danger:#B42318;--tag-bg:#EEF0F3;--tag-fg:#3D434D}
@media (prefers-color-scheme:dark){:root{--bg:#121418;--surface:#1B1E24;--line:#2C313A;--text:#E9EBEF;--muted:#A0A7B3;--chip:#2C313A;
--accent:#7AAEFF;--accent-soft:#172234;--accent-text:#9CC2FF;--on-accent:#0D1420;--warn-bg:#3A2614;--warn-fg:#F5B072;--warn-line:#7A4A1E;
--ok-bg:#13281D;--ok-fg:#8FD9AE;--ok-line:#245A3B;--danger:#FF9C8F;--tag-bg:#262A32;--tag-fg:#C9CED6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow-wrap:anywhere}
.muted{color:var(--muted)}.small{font-size:14px}.tiny{font-size:12px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
header.top{background:var(--surface);border-bottom:1px solid var(--line)}
.top .in{max-width:1120px;margin:0 auto;padding:12px 32px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px;min-height:44px}
.search{flex:1 1 280px;max-width:460px;margin:0 auto;display:flex}
.search input{flex:1;min-width:0;min-height:44px;padding:0 14px;border:1px solid var(--line);border-right:0;border-radius:10px 0 0 10px;background:var(--bg);color:var(--text);font:inherit}
.search button{border-radius:0 10px 10px 0}
.me{display:flex;align-items:center;gap:12px;margin-left:auto}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--chip);display:grid;place-items:center;font-weight:600;font-size:13px;flex:none}
.avatar.lg{width:40px;height:40px;font-size:15px}
main{max-width:1120px;margin:0 auto;padding:32px;display:flex;flex-direction:column;gap:32px}
main.narrow{max-width:760px;gap:20px}
h1{margin:0;font-size:28px;line-height:1.25;font-weight:600}
h2{margin:0;font-size:20px;font-weight:600}
.head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 12px}
.btn{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit;font-weight:500;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.btn.danger{color:var(--danger)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px}
.needs{border:1px solid var(--accent);background:var(--accent-soft);border-radius:14px;padding:20px 24px;display:flex;flex-direction:column;gap:12px}
.eyebrow{margin:0;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-text)}
.handoff{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;min-height:52px;padding:12px 16px;border-radius:10px;background:var(--surface);border:1px solid var(--line)}
.handoff:hover{text-decoration:none;border-color:var(--accent)}
.calm{color:var(--muted);margin:0}
.cols{display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start}
.col-main{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:12px}
.col-side{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:12px}
.person{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:4px 14px;align-items:start;padding:14px 16px}
.person.warn{border-color:var(--warn-line)}
.person .avatar{grid-row:span 2}
.person .body{grid-column:2/span 2;display:flex;flex-direction:column;gap:2px;min-width:0}
.chip{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--tag-bg);color:var(--tag-fg)}
.chip.warn{background:var(--warn-bg);color:var(--warn-fg)}
.chip.accent{background:var(--accent-soft);color:var(--accent-text);letter-spacing:.06em;text-transform:uppercase}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
.timeline li:last-child{border-bottom:0}
.more{display:flex;align-items:center;justify-content:center;min-height:44px;color:var(--accent-text);font-weight:600;font-size:14px}
.notes{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.note{display:flex;flex-direction:column;gap:6px;padding:16px}
.note:hover{text-decoration:none;border-color:var(--accent)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:12px 16px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.grow{flex:1 1 200px;min-width:0;display:flex;flex-direction:column}
select,.field input{min-height:44px;padding:0 10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
label.inline{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--muted)}
.field{display:flex;flex-direction:column;gap:4px;font-size:14px;color:var(--muted);flex:1 1 200px}
.notice{margin:0;padding:12px 16px;border-radius:10px;background:var(--ok-bg);color:var(--ok-fg);border:1px solid var(--ok-line);font-weight:500}
.notice.bad{background:var(--warn-bg);color:var(--warn-fg);border-color:var(--warn-line)}
.list{list-style:none;margin:0;padding:0}.list li+li{border-top:1px solid var(--line)}
a.row:hover{text-decoration:none;background:var(--bg)}
.chip.open{background:var(--accent-soft);color:var(--accent-text)}.chip.done{background:var(--ok-bg);color:var(--ok-fg)}
.done .title{color:var(--muted)}
.btn.cur{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-text)}
.jump{display:flex;flex-wrap:wrap;gap:8px}
.jump a{min-height:36px;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border-radius:999px;border:1px solid var(--line);background:var(--surface);font-size:14px}
.jump .n{font-weight:600;color:var(--accent-text)}
details.fold summary{min-height:44px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:14px;font-weight:500;color:var(--accent-text);list-style:none}
details.fold summary::-webkit-details-marker{display:none}
details.fold[open] summary svg{transform:rotate(90deg)}
details.fold .doc{margin-top:4px;padding:12px 14px;border-radius:8px;background:var(--bg);gap:6px;font-size:14px;line-height:1.55}
.doc .hd{font-weight:600}
.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.roles>div{padding:12px 16px}
details summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:500}
.confirm summary{list-style:none}.confirm summary::-webkit-details-marker{display:none}
.meta{display:flex;flex-wrap:wrap;gap:8px 20px;padding:12px 16px}
.meta a,.doc a{text-decoration:underline;color:var(--accent-text)}
.doc{padding:24px;display:flex;flex-direction:column;gap:10px;line-height:1.6}
.doc h2{font-size:17px;margin-top:6px}.doc p{margin:0}.doc ul{margin:0;padding-left:20px}
.center{min-height:70vh;display:grid;place-items:center;padding:32px}
.state{max-width:420px;width:100%;display:flex;flex-direction:column;gap:14px;padding:28px}
.state.warn{border-color:var(--warn-line)}
@media (max-width:640px){.top .in,main{padding-left:16px;padding-right:16px}main{padding-top:16px;gap:24px}.needs{padding:14px}h1{font-size:24px}}
`;

export const ICON_LINK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="color:var(--accent)"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>`;
const ICON_CHEVRON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

/** A post's optional details, folded under its summary; nothing when it has none. */
export const detailsFold = (details: string | null, about: string | null): string =>
  details
    ? `<details class="fold"><summary>${ICON_CHEVRON}Details${about ? `<span class="sr-only"> for: ${escapeHtml(about)}</span>` : ""}</summary><div class="doc">${renderNoteBody(details, false)}</div></details>`
    : "";

export const ICON_GITHUB = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>`;

export interface Viewer {
  login: string;
  role: string | null;
  /** May open /admin (an admin, or a hidden operator). */
  manage?: boolean;
}

export interface Shell {
  title: string;
  body: string;
  viewer?: Viewer;
  q?: string;
  narrow?: boolean;
  /** Marks the header's "Your notes" button as the current page. */
  onMe?: boolean;
  status?: number;
  headers?: Headers;
  /** Override the page's CSP (the OAuth consent page needs forms that redirect off-site). */
  csp?: string;
}

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

export const initial = (name: string): string => escapeHtml([...name.trim()][0]?.toUpperCase() ?? "?");

function topBar(s: Shell): string {
  const v = s.viewer;
  const right = v
    ? `<form class="search" role="search" method="get" action="/feed"><label for="q" class="sr-only">Search team knowledge</label>
<input id="q" name="q" value="${escapeHtml(s.q ?? "")}" placeholder="Search how things work and why"><button class="btn primary">Search</button></form>
<div class="me"><a class="btn${s.onMe ? " cur" : ""}" href="/me"${s.onMe ? ' aria-current="page"' : ""}>Your notes</a>${v.manage ? '<a class="btn" href="/admin">Manage access</a>' : ""}
<span style="display:flex;align-items:center;gap:8px"><span class="avatar" aria-hidden="true">${initial(v.login)}</span><span class="small">${escapeHtml(v.login)}${v.role ? ` <span class="muted">· ${escapeHtml(v.role)}</span>` : ""}</span></span></div>`
    : "";
  return `<header class="top"><div class="in"><a class="brand" href="/feed">${ICON_LINK} session-link</a>${right}</div></header>`;
}

/** Renders a full page with the shared shell and safe headers. */
export function render(s: Shell): Response {
  const headers = s.headers ?? new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", s.csp ?? PAGE_CSP);
  headers.set("cache-control", "no-store");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(s.title)} · session-link</title><style>${CSS}</style></head>
<body>${topBar(s)}${s.body}</body></html>`,
    { status: s.status ?? 200, headers },
  );
}

/** A centered single-message page (sign-in, not on the list, not found). */
export function statePage(o: { title: string; heading: string; body: string; action: string; warn?: boolean; status?: number; headers?: Headers; viewer?: Viewer }): Response {
  return render({
    title: o.title,
    viewer: o.viewer,
    status: o.status,
    headers: o.headers,
    body: `<div class="center"><section class="card state${o.warn ? " warn" : ""}"><h1 style="font-size:22px">${escapeHtml(o.heading)}</h1>${o.body}${o.action}</section></div>`,
  });
}

/**
 * Teammate-written markdown shown as safe HTML: every line is escaped first, and only
 * "## " headings and "- " list items get structure. Nothing else is interpreted.
 * With `headings: false`, "## " lines become bold paragraphs, for text nested in a page with its own outline.
 */
export function renderNoteBody(md: string, headings = true): string {
  const out: string[] = [];
  let list = false;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item && !list) (out.push("<ul>"), (list = true));
    if (!item && list) (out.push("</ul>"), (list = false));
    if (item) out.push(`<li>${escapeHtml(item[1]!)}</li>`);
    else if (/^#{1,6}\s+/.test(line)) {
      const text = escapeHtml(line.replace(/^#{1,6}\s+/, ""));
      out.push(headings ? `<h2>${text}</h2>` : `<p class="hd">${text}</p>`);
    }
    else if (line.trim()) out.push(`<p>${escapeHtml(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}
