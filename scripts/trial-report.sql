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
-- kept 30 days; the updates rows themselves expire after 2 days.)
SELECT author_id, json_extract(detail, '$.kind') AS kind, COUNT(*) AS posts
FROM events WHERE type = 'intent_posted'
GROUP BY author_id, kind ORDER BY author_id, kind;

-- 4. Who has gone quiet: last post per person.
SELECT a.id, datetime(MAX(u.updated_at) / 1000, 'unixepoch') AS last_post
FROM authors a LEFT JOIN updates u ON u.author_id = a.id AND u.source = 'mcp'
WHERE a.revoked_at IS NULL GROUP BY a.id ORDER BY last_post;

-- 5. Rejections: redaction and allowlist misses worth a look.
SELECT type, json_extract(detail, '$.reason') AS reason, json_extract(detail, '$.code') AS code, COUNT(*) AS n
FROM events WHERE type IN ('redaction_reject', 'webhook_ignored')
GROUP BY type, reason, code ORDER BY n DESC;

-- 6. Handoffs and knowledge use.
SELECT type, author_id, COUNT(*) AS n
FROM events WHERE type IN ('handoff_created', 'handoff_accepted', 'knowledge_saved', 'knowledge_searched')
GROUP BY type, author_id ORDER BY type, author_id;
