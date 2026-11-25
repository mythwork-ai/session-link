# session-link

session-link links a small team's Claude Code sessions through one shared ledger. Claude writes to it and reads from it through an MCP connector. People read the same ledger as a web page at `/feed`. The design, the alternatives it rejected, and the safety rules are in [`docs/design.md`](docs/design.md).

| Part | What it is |
|---|---|
| `worker/` | A Cloudflare Worker with a D1 database. It serves the MCP connector (`/mcp`, GitHub sign-in), the `/feed` page, the admin API, and an optional GitHub webhook (`/v1/gh`). |
| `plugin/session-link/` | The Claude Code plugin. It bundles the connector (`.mcp.json`) and five hooks that make no network calls. They prompt Claude to read and post, warn before Claude edits a file a teammate is changing, point at team knowledge about that file, and offer team context for new PRs. |
| `scripts/` | `backfill.mjs` (seeds 7 days of GitHub activity, if the webhook is in use), `trial-report.sql` (the two-week keep-or-delete review) and `outcomes.mjs` (PR review and merge times before and during the trial). |

**Setting it up for your org?** See [Run it for your org](#run-it-for-your-org). **Joining an existing instance?** See [Joining an instance](#joining-an-instance-each-person-about-two-minutes). **Want the why?** Read [`docs/overview.md`](docs/overview.md).

## How it works

**Reading.** At session start, a hook tells Claude to call `read_feed` for the current repo. Claude then mentions any teammate working on the same files. `read_feed` returns recent updates plus a map of which paths each teammate is changing. A hook caches that map, and before Claude edits a file on it, another hook adds a one-time warning.

**Writing, only with your yes.** Nothing is shared unless you agree, either each time or once in settings. After a major milestone (a commit or PR, a decision, a blocker, finishing a task, starting work others might collide with), Claude asks in one line, "Share status with team?", with a one-sentence draft, and calls `post_update` only if you say yes. The Stop hook spots new commits and hands Claude the repo, branch and paths for the draft; Claude spots the other milestones itself. It won't ask twice about the same commit, and asks at most every 10 minutes (`SESSION_LINK_ASK_MIN`; `0` turns the commit ask off, and auto-posting with it). If you'd rather not be asked about commits, turn on the `auto_post_updates` plugin setting (off by default): Claude then posts the commit update without asking, on the same schedule, and tells you in one line what it posted. You review it after it's posted, not before, and can remove it with `delete_my_update`. Other milestones, handoffs and knowledge notes still ask.

**Presence, if you turn it on.** With the `share_presence` plugin setting on (it's off by default), Claude shares which branch and files you're editing in team repos, without asking each time and without any summary. Like **Auto-post status updates**, it shares without a per-post yes only because you opted in once. Teammates' edit warnings then cover work you haven't committed or announced yet. The row expires about 4 hours after your last edit.

**Knowledge where it applies.** If a team knowledge note lists the file Claude is about to edit, a hook points Claude at it once: read it with `get_note` before changing how that part works.

**PR context, with your yes.** After Claude creates a PR with `gh pr create`, it calls `pr_context` for the branch. That returns your updates on the branch, team decisions and knowledge notes about the same files, and any handoff for it, as links. If there is anything, Claude shows it and asks "Add team context to the PR description?". PR descriptions can be public, so it never adds it without that yes.

**People** sign in with GitHub at `/feed` to see who is active and the last 48 hours of updates.

## Using it day to day

- **Let it read.** At the start of a session in a team repo, Claude checks the feed on its own and tells you if anyone is on the same files. You can also ask at any time: "is anyone working on `src/auth`?" (Claude calls `who_is_touching`), or "what's the team doing?" (`read_feed`).
- **Say yes at real milestones.** When Claude asks "Share status with team?", say yes if a teammate would change what they do because of it: you started something others might touch, you're blocked, you decided something, or you opened a PR. Edit the draft so it says *why*, not just *what*. Say no to experiments and throwaway work.
- **Share early for overlap.** Overlap warnings only know about paths someone has shared. If you're starting on a shared area, say "share that I'm starting on the auth refactor" before the first commit, and teammates' sessions will warn before touching those files.
- **Fix mistakes right away.** "Delete my last session-link update" (Claude calls `delete_my_update`). A newer update from the same session replaces the older one automatically.
- **Hand off, don't just leave.** Before switching away from unfinished work someone else will pick up, say "hand this off to <name>".
- **Leave yourself a note.** When you stop mid-task, Claude offers "Save where you left off?". Your next session in that repo offers to load it. With **Automatic notes to self** on, Claude saves and loads the note without asking. Notes to yourself are private and last 14 days.
- **Turn on presence if you'd rather not think about sharing.** `/plugin` → session-link → settings → **Share presence**. It shares repo, branch and file paths only.
- **Skip the per-post prompts.** In the same settings, **Auto-post status updates** posts your commit updates without asking, and **Automatic notes to self** saves where you left off and loads it at your next session without asking.
- **Save the why when something lands.** When Claude offers "Save how this works for the team?" after a merge, say yes for anything someone might build on later.
- **Glance without Claude.** `https://<your instance>/feed` shows who's active and the last 48 hours.

## Examples

### "I want to make sure Sam isn't working on this"

**Sam starts first.** He opens Claude Code in `acme/app`, on branch `auth-refactor`.

1. At session start, his Claude calls `read_feed(repo_url="github.com/acme/app")`. Nobody else is active, so it says nothing.
2. He works for a while, and Claude commits. On that turn's Stop, the hook sees a new commit and Claude asks:
   > Share status with team? "Refactoring the auth middleware so session tokens move to httpOnly cookies."
3. Sam says yes. Claude calls `post_update` with that summary, `branch: "auth-refactor"`, and `paths: ["src/auth/session.ts", "src/auth/middleware.ts"]`.

**You start 25 minutes later**, in the same repo, to fix a login bug.

4. At session start, your Claude calls `read_feed` for the repo and tells you:
   > Sam is refactoring the auth middleware (branch auth-refactor, 25m ago), touching src/auth/session.ts and src/auth/middleware.ts.

   A hook caches that path map for your session.
5. You can ask outright: "is anyone working on `src/auth/session.ts`?" Claude calls `who_is_touching` and answers from the same data.
6. If Claude goes to edit `src/auth/session.ts` anyway, the edit hook adds a one-time note first: *"Sam (auth-refactor, 27m ago) also changed src/auth/session.ts."* Claude tells you before making large changes, and you message Sam.

**Limits worth knowing.**
- You only see Sam's work if he said yes to sharing it, or turned on presence. Otherwise work he kept to himself, or hasn't committed or announced yet, is invisible.
- Edit warnings only cover activity from the last 4 hours. Older posts still show in `read_feed`, but don't trigger the warning.
- Each of you must have the plugin installed and be signed in.

### Blocked on someone

You can't test a migration without staging database credentials. Tell Claude "share that I'm blocked on staging DB credentials", or say yes when it offers. It posts a `blocker` row with no file paths. Teammates see it in `read_feed` for that repo, or by asking "is anyone blocked or asking for something?" (Claude calls `read_feed` with `kind`). It also shows on `/feed`. Blockers expire after 2 days; post again if it's still true.

### A decision the team should know

You decide that billing webhooks retry five times with backoff, then go to a dead-letter queue. Claude offers to share it as a `decision` and you say yes. Decisions never expire. They show in a teammate's session-start `read_feed` for that repo during the first 48 hours, and anyone can find them later with "any decisions in this repo from the last week?". Write anything permanent into the repo's docs or CLAUDE.md too; the ledger is for awareness, not the record.

### Work you don't want to share

You're prototyping something you may throw away. Claude commits and asks "Share status with team?". You say no. Nothing is posted, and Claude won't ask again about that commit. To stop the commit prompts for a whole session, set `SESSION_LINK_ASK_MIN=0`; to turn every hook off on a machine, set `SESSION_LINK_OFF=1`.

### Sam hands off to you, and you continue with full context

Sam is halfway through the auth refactor and has to switch to something urgent.

1. He tells his Claude "hand this off to Alex". Claude drafts a handoff note from the session, the commits and the diff. The note has fixed sections: Goal, Done, Remaining, Decisions and why, Gotchas, How to test, Branch/PR, Key files. Claude then asks:
   > Hand this off to Alex? "Auth refactor: cookie migration half done"
2. Sam reads it, fixes anything wrong, and says yes. Claude calls `create_handoff(to: "alex", …)` with the note, the repo, the branch `auth-refactor` and the key paths. The note is private to the two of you.
3. Your next session in any repo calls `read_feed`, which lists it under "handed to you". Claude says:
   > Sam handed you "Auth refactor: cookie migration half done" (branch auth-refactor). Load it and check out the branch?
4. You say yes. Claude calls `get_note` and reads the whole note: what's done, what's left, why SameSite=Lax was chosen, which test is flaky. It checks out `auth-refactor` and calls `accept_handoff`. It may also offer to share "Alex picked up the auth refactor from Sam".

"Full context" here means Sam's curated note plus the branch, commits and PR, not his raw chat transcript. The note is what he reviewed and agreed to share. It also holds the *why*, which commits and code don't. Open handoffs expire after 30 days, and accepted ones 14 days later. Anything worth keeping long-term belongs in a knowledge note (next example).

### A month later, building on what the team made

The team shipped billing webhook retries. When the PR merged, the author's Claude asked:
> Save how this works for the team? "Billing webhook retries"

They said yes. Claude saved a knowledge note with these sections: What it is, How it works, Decisions and why, Trade-offs and rejected options, Where things live, Gotchas. For example: five attempts with backoff, because the provider also retries for an hour; failures go to a dead-letter queue; rejected: unlimited retries, because of duplicate charges.

A month later, you ask Claude to add retry metrics.

1. Before planning, Claude calls `search_knowledge("webhook retries")`, finds the note, and reads it with `get_note`.
2. It plans with the original decisions in hand: it keeps the five-attempt limit and knows where the dead-letter queue lives. If your change alters how things work, it offers to save an updated note with `supersedes`, so the old one is replaced rather than contradicted.
3. Session start also lists the 5 most recent knowledge notes for the repo. You or a teammate can search them on `/feed`.

Knowledge notes never expire. Delete one with `delete_my_update` if it's wrong, or replace it with `supersedes`.

### Seeing work nobody announced yet (presence)

Sam has **Share presence** on. He starts editing `src/billing/retry.ts` on `feat/retries` and hasn't committed. On his first edit, a hook hands his Claude the repo, branch and the files he has edited this session, and Claude calls `set_presence` without interrupting him. Twenty minutes later your Claude goes to edit the same file, and the edit hook says *"Sam (feat/retries, 20m ago) also changed src/billing/retry.ts."* His card on `/feed` reads "working · Working on feat/retries · 2 files". Claude refreshes his row when he touches a new file, or after 10 minutes of further edits. It expires about 4 hours after he stops.

### A PR that carries its why

You open a PR from `feat/retries`. Right after `gh pr create`, Claude calls `pr_context` and shows:
> Team context (session-link):
> - Update: Retries now back off exponentially
> - Decision by Alex: Five attempts, matching the provider
> - Team knowledge: [Billing webhook retries](https://<your instance>/notes/…)
>
> Add team context to the PR description?

On yes, Claude appends it with `gh pr edit`. The reviewer gets the decisions behind the change without asking. Note links need a session-link sign-in.

### Picking up where you left off

You stop on Friday halfway through a refactor. Claude asks "Save where you left off?" and you say yes. It calls `create_handoff` with `to: "me"` and a short note: Goal, Done, Next step, Open questions, Branch. On Monday your first session in that repo offers to load it. It also shows on `/feed` under "Where you left off" until you mark it picked up, and expires after 14 days.

### Catching up after a day off

Ask Claude "what has the team been up to in the last two days?". It calls `read_feed(since_hours=48)`, or up to 168 for a week, and summarizes. Or open `/feed` in a browser.

## What gets recorded, and what never does

The ledger records only what you agreed to share: a kind, a one-sentence summary, and optionally the repo, branch, repo-relative paths and links. With presence on, it also records your repo, branch and changed paths, with no summary. If the optional webhook is on, it also records PRs and branch pushes by people on the roster. It never records transcripts, prompts or file contents, because there is no field for them. Posts that look like they contain a secret are rejected.

Nothing is recorded from repos outside your instance's allowlist (the repos you gave setup, e.g. `github.com/acme/*`). The hooks check it on your machine, and the server checks it again.

Rows expire on their own:

| Row type | Expires after |
|---|---|
| Status, progress, blocker and ask posts | 2 days |
| Decisions | Never (see design.md) |
| Pushes (webhook) | 1 day |
| PRs (webhook) | 7 days |
| Presence (repo, branch, paths) | About 4 hours after the last edit |
| Notes to yourself | 14 days |

A daily job hard-deletes expired rows. You can delete any of your own rows at any time with `delete_my_update`. `SESSION_LINK_OFF=1` stops all hooks on a machine.

## Who can get in

Access is invite-only, and roles decide what each person can do:

| Role | Can |
|---|---|
| viewer | read the feed, search knowledge, read notes and the handoffs sent to them |
| editor | everything a viewer can, plus post updates, hand off work, save knowledge, delete their own entries |
| admin | everything an editor can, plus add and remove people and change roles at `/admin` |

Setup makes the admins you name. GitHub sign-in only proves who you are. Being on this list is what grants access, so nobody gets in on org membership alone. Admins manage the list at `/admin` on their instance: add by GitHub login, change roles, remove, or restore. Every change is logged on that page, and there is always at least one admin. Removing someone ends their access immediately.

**Operators.** Someone can manage access without being shown as an admin, for example the person who runs the instance. Put their login in the `OPERATORS` secret (`npx wrangler secret put OPERATORS`, comma-separated). They keep their normal role on the roster and in the top bar, they aren't named on the "ask an admin" page, and they don't count toward the at-least-one-admin rule. They must still be on the list, and removing them ends their access as usual.

## Run it for your org

Each org runs its own instance in its own Cloudflare account, with its own data, admins and address. Everyone uses the same plugin, which an org admin points at their instance once.

**1. Set up the instance** (about ten minutes, once). You need Node 20+, a Cloudflare account with R2 enabled, and optionally a domain on Cloudflare:

```sh
git clone https://github.com/mythwork-ai/session-link && cd session-link/worker
npm ci
npm run setup
```

Setup asks for:
- an instance name;
- a custom domain, or none to use the free workers.dev address;
- your team's repos, e.g. `github.com/acme/*`;
- the first admins' GitHub logins.

It then:
1. logs you in to Cloudflare;
2. creates the database, key-value store and backup bucket;
3. writes `worker/wrangler.jsonc`, which isn't committed;
4. applies the database migrations;
5. deploys;
6. generates the server secrets, saving the admin token to your keychain;
7. walks you through creating the GitHub OAuth app, then adds your admins and prints what to do next.

Running it again is safe: it reuses what exists and fills in what's missing. It adds admins only if they aren't already on the list, so it never undoes a removal made at `/admin`. On macOS the admin token goes to the keychain; elsewhere it goes to `~/.session-link/<name>-admin-token` with mode 0600. For a run with no prompts, put the OAuth app's credentials in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, or add `--skip-github`:

```sh
npm run setup -- --name acme-link --host session-link.acme.com --allowlist "github.com/acme/*" --admins "alice=Alice,bob" --yes
```

**2. Roll it out.** The recommended way is a Claude org owner pasting the JSON that setup prints into **claude.ai → Organization settings → Claude Code → Managed settings**. It registers the plugin's marketplace with auto-update, turns the plugin on for everyone, and fills in your server URL and repos, so members just open Claude Code and sign in. Per Claude Code's documentation, plugin settings from a project's own files are ignored, so a cloned repo can't redirect the connector.

```json
{
  "extraKnownMarketplaces": { "session-link": { "source": { "source": "github", "repo": "mythwork-ai/session-link" }, "autoUpdate": true } },
  "enabledPlugins": { "session-link@session-link": true },
  "pluginConfigs": { "session-link@session-link": { "options": { "server_url": "https://session-link.acme.com", "repo_allowlist": "github.com/acme/*" } } }
}
```

Members need read access to the marketplace repo; making it public removes that step. Leave `share_presence`, `auto_post_updates` and `auto_self_notes` out of the managed options so each person chooses them.

**3. Add people** at `https://<your instance>/admin`.

## Joining an instance (each person, about two minutes)

An admin adds your GitHub login at `/admin` first. Each Claude account you use signs in once, with the same GitHub account.

1. If your org rolled it out through managed settings, skip to step 3. Otherwise add the marketplace and install the plugin **for your user**, not for one project:
   ```
   /plugin marketplace add mythwork-ai/session-link
   ! claude plugin install session-link@session-link --scope user
   ```
2. Open `/plugin`, select session-link, and enter your team's server URL and repos in its settings. Your admin gives you both. Turn on **Share presence** here too if you want it.
3. Start a new session, run `/mcp`, select the session-link **ledger** server, and sign in with GitHub.
4. Run `/session-link:setup` to confirm the connection.

**Why user scope.** Claude Code reads a project-scope install only in the folder a session starts in, not in folders below it. A plugin installed from `~/code/acme` is missing from a session started in `~/code/acme/app`. It has no setting for "this folder and everything under it". A user-scope install loads everywhere, and the hooks still act only in repos on your team's allowlist: elsewhere they share nothing and say nothing. If you already installed at project scope, run `! claude plugin install session-link@session-link --scope user`, then `! claude plugin uninstall session-link@session-link --scope project` from the folder you installed it in. Your settings carry over, because Claude Code keeps plugin options in your user settings either way.

You need `git` and `jq` installed. To use the connector in claude.ai or the desktop app without the hooks, add `https://<your instance>/mcp` as a connector there. Without the hooks nothing prompts Claude to read the feed, so ask it ("what's the team doing in agent-router?"). Plugin updates arrive automatically with managed settings; otherwise run `/plugin marketplace update session-link` and then `/reload-plugins`.

## Running it

All admin routes take `-H "authorization: Bearer $ADMIN_TOKEN"`.

| Task | How |
|---|---|
| Add, remove, or change someone's role | `/admin` in a browser (admins). Break-glass: `POST /v1/admin/authors` with `{"id":"<github-login>","display_name":"<Name>","role":"editor"}` and the admin token |
| Turn everything off for everyone | `PUT /v1/admin/settings` with `{"kill_switch":true}` (and `false` to turn it back on). Reads come back empty and posts are refused. |
| Change the allowlist without a deploy | `PUT /v1/admin/settings` with `{"repo_allowlist":["github.com/acme/*"]}` |
| See who's quiet | `GET /v1/admin/roster` (each person's last post), or the People table on `/feed` |
| Offboard someone | **Remove** at `/admin`. Their MCP access and web session end at once. |
| Bring someone back | **Restore** at `/admin`, then they sign in again |
| Purge a leaked row now | `DELETE /v1/admin/updates/<id>`, or the author's own `delete_my_update` |
| Two-week review | `npx wrangler d1 execute LEDGER_DB --remote --file ../scripts/trial-report.sql` |
| Team outcomes | `node scripts/outcomes.mjs --org acme` (or `--repo acme/app`, repeatable; `--before` and `--during` take `YYYY-MM-DD..YYYY-MM-DD`) |

**Measuring the trial.** Usage alone can't tell you whether the team got faster, and people misjudge their own speed. Judge it on outcomes:
- `trial-report.sql` counts overlaps the server caught (two people's shared paths meeting in a repo, counted once per pair, repo and fixed 4-hour window), presence adoption, and use of PR context and notes to yourself, along with reads and posts.
- `outcomes.mjs` compares the two weeks before with the trial: PR count, median and p90 hours to first review and to merge, median PR size, and the share of open PRs that conflict. The conflict share is a proxy, since GitHub only reports whether a PR conflicts now.

If the trial report shows nobody reading or posting beyond the nudges, and outcomes didn't move, delete the plugin. That is the agreed kill criterion.

## Development

```sh
cd worker && npm ci && npx tsc --noEmit && npx vitest run   # Worker tests, with real D1/R2/KV in miniflare
shellcheck -x -P plugin/session-link/scripts plugin/session-link/scripts/*.sh
node --test test/hooks/hooks.test.mjs                        # hook contract tests
node --test test/setup.test.mjs test/outcomes.test.mjs       # setup and outcomes helpers
```

CI runs all of these on every PR. Changes under `plugin/`, `worker/src/safety/`, `worker/src/auth/` and `.github/` need code-owner review.

## Moving an instance

To move to a new Cloudflare account or domain:
1. Run `npm run setup` there with a new name.
2. Point the GitHub OAuth app's redirect URIs at the new address.
3. Update the server URL in managed settings, or in each person's plugin settings.
4. Re-add people at `/admin`.

Everyone signs in again once. There's no import tool yet. The old instance's nightly JSONL exports in R2 hold its history if you need to load it by hand.
