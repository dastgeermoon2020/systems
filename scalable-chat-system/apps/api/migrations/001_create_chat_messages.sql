CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(100) NOT NULL,
    sender_id VARCHAR(100) NOT NULL,
    content TEXT NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 4000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_messages_room_created_idx
    ON chat_messages (room_id, created_at DESC, id DESC);
