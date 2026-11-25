-- Optional longer context for a post: the repo, which repos and components it affects (and which
-- it doesn't), why, what's next. Scrubbed like note bodies, <= 1000 chars. NULL for webhook and presence rows.
ALTER TABLE updates ADD COLUMN details TEXT;
