-- Longer-lived, longer-form entries: handoffs (one person to another) and team knowledge
-- (how something works and why). Both are written only with the author's yes.
CREATE TABLE notes (
  rid         INTEGER PRIMARY KEY AUTOINCREMENT,   -- rowid for the full-text index
  id          TEXT NOT NULL UNIQUE,
  author_id   TEXT NOT NULL REFERENCES authors(id),
  kind        TEXT NOT NULL CHECK (kind IN ('handoff','knowledge')),
  title       TEXT NOT NULL,                       -- one line, <= 120 chars
  body        TEXT NOT NULL,                       -- markdown, scrubbed, <= 16 KB
  tags        TEXT NOT NULL DEFAULT '[]',
  repo        TEXT,
  branch      TEXT,
  paths       TEXT NOT NULL DEFAULT '[]',
  links       TEXT NOT NULL DEFAULT '[]',
  to_author   TEXT REFERENCES authors(id),         -- handoffs only
  status      TEXT CHECK (status IN ('open','accepted','closed')),
  client_id   TEXT NOT NULL,
  supersedes  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER                              -- NULL = never (knowledge)
);
CREATE UNIQUE INDEX notes_client ON notes(author_id, client_id);
CREATE INDEX notes_to ON notes(to_author, status);
CREATE INDEX notes_repo ON notes(repo, kind, updated_at);

CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tags, content='notes', content_rowid='rid');
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.rid, new.title, new.body, new.tags);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.rid, old.title, old.body, old.tags);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.rid, old.title, old.body, old.tags);
  INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.rid, new.title, new.body, new.tags);
END;
