# session-link in one page

## The problem

Each of us works through our own Claude Code sessions, so nobody's Claude knows what the rest of the team is doing. Two people can be in the same files without knowing. Context dies when someone switches tasks. Decisions made in one session are gone a month later.

## What it does

session-link gives the team's Claude sessions one shared memory, with these kinds of entry:

| Entry | What it is | How long it lives |
|---|---|---|
| **Status** | One sentence: what you're doing and why, plus repo, branch and files. Kinds: progress, status, blocker, ask, decision. | 2 days (decisions: forever) |
| **Handoff** | A structured note from one person to another: goal, done, remaining, decisions and why, gotchas, how to test, branch/PR, key files. Private to the two of you. | 30 days open, 14 days after it's accepted |
| **Knowledge** | How something works and why: design, decisions, rejected options, where things live. Searchable by everyone. | Forever, until replaced |
| **Note to yourself** | Where you left off: goal, done, next step, open questions, branch. Only you see it. | 14 days |
| **Presence** (opt-in) | Repo, branch and the files you're editing. No summary. | About 4 hours after your last edit |

Claude reads and writes it through a connector (an MCP server). People read it in a browser at `/feed`.

## How it feels day to day

- **You open a session.** Claude checks the feed for your repo and tells you if a teammate is on the same files, or has handed you something.
- **You commit.** Claude asks "Share status with team?" with a one-line draft. You say yes, edit it, or say no.
- **Claude is about to edit a file a teammate is changing.** It tells you first.
- **You're handing work off.** You say "hand this off to Sam". Claude drafts the note and sends it after your yes. Sam's next session offers to load it and check out the branch.
- **A feature lands.** Claude offers "Save how this works for the team?". A month later, anyone's Claude finds it before building on top of that feature. When Claude edits a file a note covers, it's pointed at that note.
- **You open a PR.** Claude offers to add team context to the description: your updates on the branch, related decisions and knowledge. The reviewer gets the why.
- **You stop mid-task.** Claude offers "Save where you left off?". Your next session offers to load it.
- **You turned on presence.** Teammates' sessions see which files you're in before you commit, and you're never asked.

## Design choices, and why

| Choice | Why |
|---|---|
| **Nothing is shared without your yes** | What's shared is what you meant to share, with the why, not a stream of automatic logs that can leak secrets or read as surveillance. The one exception is presence, which you turn on once and which carries no prose. |
| **Curated notes, not transcripts** | Transcripts carry secrets, customer data and noise. Nobody can meaningfully approve sharing 200 KB of chat. |
| **Claude reads and writes through one connector** | One data path and one sign-in, with no tokens on disk. |
| **Hooks only prompt; they never send** | The hooks work out local facts (repo, branch, changed files) and hand them to Claude. They make no network calls. |
| **Invite-only, with roles** | Admins decide who gets in: viewer (read), editor (also write), admin (also manage people). GitHub sign-in only proves who you are. |
| **One instance per org, one shared plugin** | Each org owns its data. The plugin's server URL is a setting an org admin can set for everyone, so updates reach every org from one place. |

## Safety

- **The repo allowlist** is checked on your machine and again on the server. Nothing from personal repos is recorded.
- **Secret-looking text is rejected**, not scrubbed: API keys, tokens, private keys, credentials, home paths.
- **Teammate text is treated as information, not instructions.** It's sanitized and labelled that way wherever it reaches Claude.
- **Handoffs are visible only** to their author and recipient.
- **You can delete anything of yours at any time.** An admin can remove anyone, and their access ends immediately.
- **A kill switch** turns everything off for everyone. `SESSION_LINK_OFF=1` turns it off on one machine.

## Where things are

| What | Where |
|---|---|
| The team page | `https://<your instance>/feed` |
| Managing access (admins) | `https://<your instance>/admin` |
| The connector | `https://<your instance>/mcp` (installed with the plugin) |
| Code, plugin, setup | https://github.com/mythwork-ai/session-link |
| Design history | `docs/design.md`, which also covers rejected options |

## How it's built

- **Server:** a Cloudflare Worker with a D1 (SQLite) database, using full-text search for knowledge. GitHub OAuth goes through `@cloudflare/workers-oauth-provider`, and the MCP tools use the official MCP SDK. Nightly backups go to R2.
- **Client:** a Claude Code plugin that bundles the connector and five shell hooks: SessionStart, Stop, PreToolUse on edits, and PostToolUse on `read_feed` and on `Bash`.
- **Setup:** `npm run setup` stands up a new instance in any org's Cloudflare account in about ten minutes.
- **Tests:** 116 server tests run against a real local D1, R2 and KV; 42 hook tests run against fixture git repos; 8 setup and 6 outcomes tests.

## Limits, honestly

- **It only knows what people share.** Work nobody shared or committed is invisible, unless its owner turned on presence.
- **Overlap warnings cover the last 4 hours** of shared file activity.
- **It's Cloudflare-only.** Hosting it elsewhere means porting the server.

## How we'll know it's working

Judge it on outcomes, not usage: people misjudge their own speed. After two weeks:
- `scripts/outcomes.mjs` compares PR review and merge times, PR size and conflicts with the two weeks before.
- `scripts/trial-report.sql` shows overlaps the server caught, feed reads that found a teammate, what people shared, and who has gone quiet.

If outcomes didn't move and nobody is reading or sharing beyond the prompts, we turn it off.
