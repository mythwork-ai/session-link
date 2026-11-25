-- Team roster. id is the lowercase GitHub login.
CREATE TABLE authors (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  emails            TEXT NOT NULL DEFAULT '[]',   -- JSON array of git user.email values
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  last_heartbeat_at INTEGER,
  last_hook_version TEXT,
  last_hook_ok      INTEGER
);

-- Hook tokens, stored as SHA-256 hex. Scope is fixed: post heartbeats, read digest, report events.
CREATE TABLE tokens (
  hash         TEXT PRIMARY KEY,
  author_id    TEXT NOT NULL REFERENCES authors(id),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX tokens_author ON tokens(author_id);

-- Every ledger row: heartbeats, intent posts, GitHub PR/push events.
CREATE TABLE updates (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES authors(id),
  kind        TEXT NOT NULL CHECK (kind IN ('heartbeat','push','pr','status','progress','blocker','decision','ask')),
  source      TEXT NOT NULL CHECK (source IN ('hook','mcp','github')),
  repo        TEXT,                          -- normalized, e.g. github.com/acme/app
  branch      TEXT,
  session_id  TEXT,
  summary     TEXT,                          -- sanitized, <= 200 chars
  paths       TEXT NOT NULL DEFAULT '[]',    -- JSON array of repo-relative paths
  links       TEXT NOT NULL DEFAULT '[]',
  client_id   TEXT NOT NULL,                 -- idempotency key, unique per author
  supersedes  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER                        -- NULL = never (decisions)
);
CREATE UNIQUE INDEX updates_client ON updates(author_id, client_id);
CREATE INDEX updates_repo ON updates(repo, updated_at);
CREATE INDEX updates_expiry ON updates(expires_at);

-- Kill-criteria and audit events. Purged after 30 days.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  author_id  TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX events_created ON events(created_at);

-- GitHub delivery IDs, for webhook dedupe and replay protection.
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- Runtime settings: kill_switch ('0'|'1'), repo_allowlist (JSON array).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
