-- Invite-only access with roles. viewer: read; editor: read + write; admin: + manage people.
ALTER TABLE authors ADD COLUMN role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer','editor','admin'));

-- The first admins are seeded by `npm run setup` for each instance, not here.
