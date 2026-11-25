#!/usr/bin/env bash
# Stop: after a milestone (a new commit since the last ask, or since session start), ask Claude
# to offer the user a team update (a one-line summary plus details) and post it only if they say yes. With the
# auto_post_updates plugin setting on (the user's one-time consent), Claude posts without asking
# and tells the user what it posted. No network call. SESSION_LINK_ASK_MIN sets the minimum
# minutes between asks or posts (default 10); 0 turns them off.
SL_HOOK=stop
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
SL_ASK_MIN="${SESSION_LINK_ASK_MIN:-10}"
case "$SL_ASK_MIN" in ''|*[!0-9]*) SL_ASK_MIN=10 ;; esac
[ "$SL_ASK_MIN" -eq 0 ] && exit 0
sl_read_input
sl_preflight
[ -n "$(sl_field .agent_id)" ] && exit 0
[ "$(sl_field .stop_hook_active)" = "true" ] && exit 0   # Claude is already continuing because of a stop hook
cwd="$(sl_field .cwd)"
sl_resolve_repo "${cwd:-$PWD}" || exit 0

head="$(sl_head)"
[ -n "$head" ] || exit 0                       # no commits yet: no milestone to offer
stamp="$SL_DATA/state/ask-$SL_SESSION"
if [ ! -f "$stamp" ]; then
  # No baseline (SessionStart didn't run): treat the current commit as already known.
  printf '0\n%s\n' "$head" >"$stamp"; exit 0
fi
[ "$(sed -n 2p "$stamp")" = "$head" ] && exit 0  # no new commit since the last ask
last="$(head -1 "$stamp")"; case "$last" in ''|*[!0-9]*) last=0 ;; esac
[ $(( $(date +%s) - last )) -lt $((SL_ASK_MIN * 60)) ] && exit 0
printf '%s\n%s\n' "$(date +%s)" "$head" >"$stamp"

paths="$(sl_changed_paths)"
branch="$(sl_branch)"
# One client_id per session: each shared update replaces this session's previous one.
args="$(printf '%s\n' "$paths" | grep . | jq -R . | jq -sc --arg r "$SL_REPO" --arg b "$branch" --arg c "session-$SL_SESSION" \
  '{repo_url: $r} + (if $b == "" then {} else {branch: $b} end) + (if length > 0 then {paths: .} else {} end) + {client_id: $c}')"
if sl_opt_on "${CLAUDE_PLUGIN_OPTION_AUTO_POST_UPDATES:-}"; then
  jq -n --arg a "$args" '{hookSpecificOutput: {hookEventName: "Stop", additionalContext:
    ("session-link: this session just made a new commit, and the user turned on auto-posting, so do not ask. Call the session-link post_update tool with kind \"progress\", a summary that starts with the repo or component, details a teammate needs to act on it (which repos and components it affects and which it does not, why, what is next, risks), never secrets, credentials, customer data or file contents, and these arguments: " + $a + ". Then tell the user in one short line what you posted.")}}'
else
  jq -n --arg a "$args" '{hookSpecificOutput: {hookEventName: "Stop", additionalContext:
    ("session-link: this session just made a new commit, which may be worth telling the team about. Ask the user in one short line: \"Share status with team?\" followed by a draft: a summary that starts with the repo or component, details a teammate needs to act on it (which repos and components it affects and which it does not, why, what is next, risks). Only if they say yes, call the session-link post_update tool with kind \"progress\", that summary and details (or their edited version), and these arguments: " + $a + ". If they say no or do not answer, do not post and do not ask again about this commit.")}}'
fi
exit 0
