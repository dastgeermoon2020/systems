ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS room_reads (
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_reads_user_idx ON room_reads (user_id, room_id);

-- Existing accounts should start with no historical unread messages.
INSERT INTO room_reads (room_id, user_id, last_read_at)
SELECT room.id, users.id, NOW()
FROM chat_rooms room
JOIN users ON room.is_public = TRUE
    OR EXISTS (
        SELECT 1 FROM room_members member
        WHERE member.room_id = room.id AND member.user_id = users.id
    )
ON CONFLICT (room_id, user_id) DO NOTHING;
