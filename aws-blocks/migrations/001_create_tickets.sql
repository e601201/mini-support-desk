CREATE TABLE tickets (
  id             TEXT PRIMARY KEY,
  owner_sub      TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  priority       TEXT NOT NULL DEFAULT 'normal',
  attachment_key TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tickets_owner_created_idx ON tickets (owner_sub, created_at DESC);