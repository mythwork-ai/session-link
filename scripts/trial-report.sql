-- Kill-criteria report for the two-week trial (design.md, meta.kill-criteria).
-- Run from worker/: npx wrangler d1 execute LEDGER_DB --remote --file ../scripts/trial-report.sql
-- Events are kept 30 days, so run this before day 30.

-- 1. Feed reads that showed at least one teammate row, per person per day.
SELECT date(created_at / 1000, 'unixepoch') AS day, author_id,
       COUNT(*) AS reads,
       SUM(json_extract(detail, '$.teammate_rows') > 0) AS reads_with_teammates
FROM events WHERE type = 'feed_read'
GROUP BY day, author_id ORDER BY day, author_id;

-- 2. Edit warnings are shown locally by the plugin and not reported to the server (v2).

-- 3. Posts per person and kind, nudged or not. (From events, which are
-- kept 30 days, while the updates rows themselves expire after 2 days.)
SELECT author_id, json_extract(detail, '$.kind') AS kind, COUNT(*) AS posts
FROM events WHERE type = 'intent_posted'
GROUP BY author_id, kind ORDER BY author_id, kind;

-- 4. Who has gone quiet: last post per person (presence rows don't count as posts).
SELECT a.id, datetime(MAX(u.updated_at) / 1000, 'unixepoch') AS last_post
FROM authors a LEFT JOIN updates u ON u.author_id = a.id AND u.source = 'mcp' AND u.kind != 'heartbeat'
WHERE a.revoked_at IS NULL GROUP BY a.id ORDER BY last_post;

-- 5. Rejections: redaction and allowlist misses worth a look.
SELECT type, json_extract(detail, '$.reason') AS reason, json_extract(detail, '$.code') AS code, COUNT(*) AS n
FROM events WHERE type IN ('redaction_reject', 'webhook_ignored')
GROUP BY type, reason, code ORDER BY n DESC;

-- 6. Handoffs and knowledge use.
SELECT type, author_id, COUNT(*) AS n
FROM events WHERE type IN ('handoff_created', 'handoff_accepted', 'knowledge_saved', 'knowledge_searched')
GROUP BY type, author_id ORDER BY type, author_id;

-- 7. Overlaps: two people's shared paths met in a repo, counted once per pair, repo and 4-hour
-- window. Fewer late collisions is the point. Compare with scripts/outcomes.mjs for PR conflicts.
SELECT json_extract(detail, '$.repo') AS repo,
       MIN(author_id, json_extract(detail, '$.with')) || ' + ' || MAX(author_id, json_extract(detail, '$.with')) AS pair,
       COUNT(*) AS overlaps, SUM(json_extract(detail, '$.files')) AS files
FROM events WHERE type = 'overlap_detected'
GROUP BY repo, pair ORDER BY overlaps DESC;

-- 8. Presence adoption: who shares presence, and on how many days.
SELECT author_id, COUNT(DISTINCT date(created_at / 1000, 'unixepoch')) AS days, COUNT(*) AS calls
FROM events WHERE type = 'presence_set'
GROUP BY author_id ORDER BY days DESC;

-- 9. Reviewer context and notes to yourself.
SELECT author_id,
       SUM(type = 'pr_context_served') AS pr_context_calls,
       SUM(type = 'pr_context_served' AND json_extract(detail, '$.empty') = 0) AS pr_context_non_empty,
       SUM(type = 'handoff_created' AND json_extract(detail, '$.self') = 1) AS notes_to_self
FROM events WHERE type IN ('pr_context_served', 'handoff_created')
GROUP BY author_id ORDER BY author_id;
