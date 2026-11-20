CREATE TABLE IF NOT EXISTS chat_rooms (
    id TEXT PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    room_type VARCHAR(16) NOT NULL CHECK (room_type IN ('channel', 'group', 'direct')),
    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    direct_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO chat_rooms (id, name, room_type, is_public)
SELECT DISTINCT room_id, room_id, 'channel', TRUE
FROM chat_messages
ON CONFLICT (id) DO NOTHING;

INSERT INTO chat_rooms (id, name, room_type, is_public)
VALUES ('general', 'general', 'channel', TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id, room_id);
CREATE INDEX IF NOT EXISTS chat_rooms_type_created_idx ON chat_rooms (room_type, created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_room_id_fkey'
          AND conrelid = 'chat_messages'::regclass
    ) THEN
        ALTER TABLE chat_messages
            ADD CONSTRAINT chat_messages_room_id_fkey
            FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE;
    END IF;
END $$;
