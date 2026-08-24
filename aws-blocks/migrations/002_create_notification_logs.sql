CREATE TABLE notification_logs (
    id         TEXT PRIMARY KEY,
    ticket_id  TEXT NOT NULL,
    type       TEXT NOT NULL,
    status     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);