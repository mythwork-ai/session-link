#!/usr/bin/env bash
# PostToolUse on session-link's read_feed: cache the returned path map for this session, so
# the PreToolUse hook can warn before Claude edits a file a teammate is changing.
SL_HOOK=post-tool-use
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
sl_read_input
sl_preflight
case "$(sl_field .tool_name)" in *__read_feed) ;; *) exit 0 ;; esac

# The tool result is MCP content: text blocks whose text is a one-line notice and then JSON.
text="$(printf '%s' "$SL_INPUT" | jq -r '
  .tool_response | if type == "string" then .
  elif type == "array" then [.[] | select(.type? == "text") | .text] | join("\n")
  elif type == "object" and (.content | type) == "array" then [.content[] | select(.type? == "text") | .text] | join("\n")
  else empty end' 2>/dev/null)"
json="$(printf '%s\n' "$text" | sed -n '/^{/,$p')"
[ -n "$json" ] || exit 0
printf '%s' "$json" | jq -e '.map | type == "object"' >/dev/null 2>&1 || exit 0
sl_write_cache "$json" || true
exit 0
