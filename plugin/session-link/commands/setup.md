---
description: Check that this machine is connected to your team's session-link server
---
Check whether the session-link MCP server's tools (read_feed, post_update) are available to you. If they are not:
- If the plugin was never configured, tell the user to open `/plugin`, select session-link, and set "session-link server URL" (their team's address, e.g. https://session-link.example.com) and "Team repos" (e.g. github.com/acme/*). Their admin may set these for everyone instead.
- Then tell them to run `/mcp`, select the session-link "ledger" server, and sign in with GitHub. An admin must have added their GitHub login first.
Once connected, call read_feed with no arguments and report how many recent updates it returned. Do not ask for or handle any token.
