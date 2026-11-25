#!/usr/bin/env bash
# Shared helpers for session-link hooks. Sourced, never executed.
# shellcheck disable=SC2034  # SL_* variables are used by the scripts that source this file
# Rules: never block a session (always exit 0), never make network calls (Claude reads and
# writes through the MCP connector; session-end.sh, when the user opts in, starts a background
# Claude that does the same), never eval tool output, write only under $SL_DATA, log
# every failure. Works on macOS bash 3.2.

# Cache, state and log live here; no environment variable can move it. The allowlist comes from
# the plugin's repo_allowlist setting, which Claude Code passes as CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST
# (user or org-managed settings only; project settings can't set plugin options).
SL_DATA="${HOME}/.session-link"
export GIT_OPTIONAL_LOCKS=0   # never take index.lock from a background hook

mkdir -p "$SL_DATA/cache" "$SL_DATA/state" 2>/dev/null
chmod 700 "$SL_DATA" 2>/dev/null

sl_log() {
  local f="$SL_DATA/hook.log"
  # Rotate at ~256 KB so the log never grows without bound.
  if [ -f "$f" ] && [ "$(wc -c <"$f")" -gt 262144 ]; then mv -f "$f" "$f.1"; fi
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SL_HOOK:-?}" "$*" >>"$f"
}

# True when a boolean plugin option ($1) is on: true, 1 or yes, in any case.
sl_opt_on() { case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in true | 1 | yes) return 0 ;; esac; return 1; }

# Reads the hook's stdin JSON once into SL_INPUT.
sl_read_input() { SL_INPUT="$(cat)"; }
sl_field() { printf '%s' "$SL_INPUT" | jq -r "$1 // empty" 2>/dev/null; }

# Exits quietly when the hook should not run at all.
sl_preflight() {
  [ "${SESSION_LINK_OFF:-}" = "1" ] && exit 0
  [ -n "${SESSION_LINK_CLOSEOUT:-}" ] && exit 0   # inside session-end.sh's background close-out
  command -v jq >/dev/null 2>&1 || { sl_log "jq not installed; session-link disabled"; exit 0; }
  command -v git >/dev/null 2>&1 || { sl_log "git not installed; session-link disabled"; exit 0; }
  SL_SESSION="$(sl_field .session_id)"
  case "$SL_SESSION" in
    "" | *[!A-Za-z0-9_-]*) sl_log "missing or odd session_id; skipping"; exit 0 ;;
  esac
}

# Team repo patterns, one per line. Empty means the hooks stay silent everywhere.
sl_allowlist() {
  if [ -n "${CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST:-}" ]; then printf '%s\n' "$CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST" | tr ',' '\n'; return; fi
  [ -f "$SL_DATA/allowlist" ] && cat "$SL_DATA/allowlist"
}

# Mirrors worker/src/safety/repo.ts: remote -> host/owner/name, lowercase. Empty on failure.
sl_normalize_repo() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E \
    -e 's#^[a-z0-9._-]+@([a-z0-9.-]+):#\1/#' \
    -e 's#^(ssh|https?|git)://([^@/]+@)?([a-z0-9.-]+)(:[0-9]+)?/#\3/#' \
    -e 's#/+$##' -e 's#\.git$##' |
    grep -E '^[a-z0-9-]+(\.[a-z0-9-]+)+/[a-z0-9._-]+/[a-z0-9._-]+$' | grep -vE '/\.\.?(/|$)'
}

sl_repo_allowed() {
  local repo="$1" pat
  while IFS= read -r pat; do
    pat="$(printf '%s' "$pat" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    [ -z "$pat" ] && continue
    case "$pat" in
      */\*) case "$repo" in "${pat%\*}"*) return 0 ;; esac ;;
      *) [ "$repo" = "$pat" ] && return 0 ;;
    esac
  done <<EOF
$(sl_allowlist)
EOF
  return 1
}

# Sets SL_ROOT, SL_REMOTE, SL_REPO for a directory, or returns 1 (not a team repo).
sl_resolve_repo() {
  SL_ROOT="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  SL_REMOTE="$(git -C "$SL_ROOT" remote get-url origin 2>/dev/null)" || return 1
  SL_REPO="$(sl_normalize_repo "$SL_REMOTE")"
  [ -n "$SL_REPO" ] || return 1
  sl_repo_allowed "$SL_REPO"
}

SL_PATHS_MAX=50
g() { git -C "$SL_ROOT" -c core.quotePath=false "$@"; }

# Changed paths: committed on this branch since the merge-base, plus staged, unstaged and untracked.
collect_paths() {
  local def="" base=""
  def="$(g symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"
  if [ -z "$def" ]; then
    for b in main master trunk; do
      g rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null 2>&1 && { def="origin/$b"; break; }
    done
  fi
  if g rev-parse -q --verify HEAD >/dev/null 2>&1; then
    [ -n "$def" ] && base="$(g merge-base HEAD "$def" 2>/dev/null)"
    [ -n "$base" ] && g diff --name-only "$base" HEAD
    g diff --name-only HEAD
  else
    g diff --cached --name-only
  fi
  g ls-files --others --exclude-standard
}

# Collapse to parent directories while over the cap (mirrors collapsePaths in the Worker).
collapse() {
  local list i=0; list="$(sort -u)"
  while [ "$(printf '%s\n' "$list" | grep -c .)" -gt "$SL_PATHS_MAX" ] && [ $i -lt 8 ]; do
    list="$(printf '%s\n' "$list" | sed -E 's#^(.+)/[^/]+/?$#\1/#' | sort -u)"; i=$((i + 1))
  done
  printf '%s\n' "$list" | grep . | head -n "$SL_PATHS_MAX"
}

# Changed paths the server will accept (repo-relative, plain characters, at most 200 chars),
# collapsed to at most 50. Needs SL_ROOT (from sl_resolve_repo).
sl_changed_paths() {
  collect_paths 2>>"$SL_DATA/hook.log" | grep -E '^[][A-Za-z0-9._/ @+()-]{1,200}$' | grep -vE '(^|/)\.\.(/|$)' | collapse
}

# Current branch, or empty when detached or when the name has characters the server rejects.
sl_branch() {
  g symbolic-ref -q --short HEAD 2>/dev/null | grep -E '^[A-Za-z0-9._/-]{1,100}$'
}

# Current commit, or empty in a repo with no commits.
sl_head() { g rev-parse -q --verify HEAD 2>/dev/null; }

sl_cache_file() { printf '%s/cache/%s.json' "$SL_DATA" "$SL_SESSION"; }

# Writes the path->owners map and the path->knowledge-notes index from a read_feed result into this
# session's cache, after shape checks. $1 is the result JSON ({repo, map, knowledge_paths, ...});
# the repo must be a normalized, allowlisted one.
sl_write_cache() {
  local reply="$1" tmp repo
  repo="$(printf '%s' "$reply" | jq -r '.repo // empty' 2>/dev/null)"
  repo="$(sl_normalize_repo "$repo")"
  if [ -z "$repo" ] || ! sl_repo_allowed "$repo"; then sl_log "read_feed result had no allowlisted repo; cache not updated"; return 1; fi
  SL_REPO="$repo"
  tmp="$(sl_cache_file).tmp"
  printf '%s' "$reply" | jq -c --arg repo "$SL_REPO" '
    if (.map | type) == "object" then
      {repo: $repo, written_at: now | floor,
       map: (.map | with_entries(select((.key | type) == "string" and (.key | length) <= 200 and (.value | type) == "array"))
                  | with_entries(.value |= [.[:5][] | {who: (.who | tostring | .[:60]), author: (.author // "" | tostring | .[:39]),
                                                        branch: (.branch // "" | tostring | .[:100]), age_s: ((.age_s // 0) | tonumber? // 0)}])),
       knowledge: (if (.knowledge_paths | type) == "object" then
                     .knowledge_paths | with_entries(select((.key | type) == "string" and (.key | length) <= 200 and (.value | type) == "array"))
                     | with_entries(.value |= [.[:3][] | select(type == "object" and (.id | type) == "string" and (.id | test("^[0-9a-f-]{36}$")))
                                                       | {id, title: (.title // "" | tostring | .[:120])}])
                   else {} end)}
    else error("bad map") end' >"$tmp" 2>/dev/null && mv -f "$tmp" "$(sl_cache_file)" && return 0
  rm -f "$tmp"; sl_log "reply had no valid map; cache not updated"; return 1
}

# Deletes per-session files older than two days (cache and state by whole days).
sl_gc() {
  find "$SL_DATA/cache" "$SL_DATA/state" -type f -mtime +2 -delete 2>/dev/null
  # Close-out transcript copies and logs: gone at the first session start two days after they were written.
  [ -d "$SL_DATA/closeout" ] && { find "$SL_DATA/closeout" -type f -mmin +2880 -delete || sl_log "couldn't clean $SL_DATA/closeout"; }
}

# jq function that makes untrusted text safe to place in context: one line, no delimiters, capped.
# shellcheck disable=SC2016  # jq program, not shell expansion
SL_JQ_CLEAN='def clean($n): tostring | gsub("[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]"; " ") | gsub("<"; "‹") | gsub(">"; "›") | gsub("`"; "'"'"'") | gsub("\""; "'"'"'") | gsub(" +"; " ") | if length > $n then .[:($n-1)] + "…" else . end;
def age: if . < 90 then "just now" elif . < 5400 then "\((. / 60) | floor)m ago" elif . < 172800 then "\((. / 3600) | floor)h ago" else "\((. / 86400) | floor)d ago" end;'
