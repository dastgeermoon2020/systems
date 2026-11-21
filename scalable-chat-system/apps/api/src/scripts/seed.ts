import "dotenv/config";
import { createHash } from "node:crypto";
import { PasswordHasher } from "@nestjs/authentication";
import { Pool } from "pg";

type SeedUser = { id: string; email: string; displayName: string };
type SeedRoom = { id: string; name: string; type: "channel" | "group" | "direct"; members: SeedUser[] };

const DEFAULT_PASSWORD = "DMChat-Seed-Only-2026!";
const userCount = readCount("SEED_USER_COUNT", 12, 2, 1000);
const channelCount = readCount("SEED_CHANNEL_COUNT", 2, 0, 100);
const groupCount = readCount("SEED_GROUP_COUNT", 3, 0, 100);
const directCount = readCount("SEED_DIRECT_COUNT", Math.min(3, (userCount * (userCount - 1)) / 2), 0, (userCount * (userCount - 1)) / 2);
const messagesPerRoom = readCount("SEED_MESSAGES_PER_ROOM", 100, 0, 20_000);
const includeGeneralMessages = process.env.SEED_INCLUDE_GENERAL === "true";
const batchSize = 500;

function readCount(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function deterministicUuid(key: string) {
  const bytes = createHash("sha1").update(`dmchat-local-seed:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createUsers(count: number): SeedUser[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return {
      id: deterministicUuid(`user:${number}`),
      email: `demo${number}@example.com`,
      displayName: `Demo Member ${number}`,
    };
  });
}

function buildRooms(users: SeedUser[]): SeedRoom[] {
  const rooms: SeedRoom[] = [{ id: "general", name: "general", type: "channel", members: users }];

  for (let index = 0; index < channelCount; index += 1) {
    const number = String(index + 1).padStart(3, "0");
    rooms.push({ id: `seed-channel-${number}`, name: `Seed Channel ${number}`, type: "channel", members: users });
  }

  for (let index = 0; index < groupCount; index += 1) {
    const number = String(index + 1).padStart(3, "0");
    const start = index % users.length;
    const memberCount = Math.min(users.length, Math.max(2, Math.min(5, users.length)));
    const members = Array.from({ length: memberCount }, (_, offset) => users[(start + offset) % users.length]);
    rooms.push({ id: `seed-group-${number}`, name: `Seed Project Group ${number}`, type: "group", members });
  }

  let directIndex = 0;
  for (let left = 0; left < users.length && directIndex < directCount; left += 1) {
    for (let right = left + 1; right < users.length && directIndex < directCount; right += 1) {
      directIndex += 1;
      const number = String(directIndex).padStart(3, "0");
      rooms.push({
        id: `seed-direct-${number}`,
        name: users[right].displayName,
        type: "direct",
        members: [users[left], users[right]],
      });
    }
  }
  return rooms;
}

function messageContent(index: number, room: SeedRoom, author: SeedUser) {
  const snippets = [
    "Quick update: I have shared the latest progress here.",
    "I reviewed this and left a few notes for the team.",
    "That works for me. Let’s keep this moving.",
    "I’ll take this follow-up and report back soon.",
    "Thanks everyone. The next step is clear now.",
  ];
  return `${snippets[index % snippets.length]} (${room.name} · ${author.displayName} · ${index + 1})`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; run this from apps/api with its local .env configured");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  let insertedMessages = 0;
  const users = createUsers(userCount);
  const rooms = buildRooms(users);
  const password = process.env.SEED_PASSWORD ?? DEFAULT_PASSWORD;

  try {
    const schema = await client.query<{ usersTable: string | null; roomsTable: string | null; readsTable: string | null }>(
      `SELECT to_regclass('public.users') AS "usersTable",
              to_regclass('public.chat_rooms') AS "roomsTable",
              to_regclass('public.room_reads') AS "readsTable"`,
    );
    if (!schema.rows[0]?.usersTable || !schema.rows[0]?.roomsTable || !schema.rows[0]?.readsTable) {
      throw new Error("Database migrations 001–004 must be applied before seeding");
    }

    const passwordHash = await new PasswordHasher().hash(password);
    await client.query("BEGIN");

    for (const user of users) {
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [user.id, user.email, user.displayName, passwordHash],
      );
      const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [user.email]);
      if (!existing.rows[0]) throw new Error(`Could not create or find ${user.email}`);
      user.id = existing.rows[0].id;
    }

    const creatorId = users[0].id;
    for (const room of rooms) {
      if (room.type === "direct") {
        const directKey = room.members.map((member) => member.id).sort().join(":");
        await client.query(
          `INSERT INTO chat_rooms (id, name, room_type, is_public, created_by, direct_key)
           VALUES ($1, $2, 'direct', FALSE, $3, $4)
           ON CONFLICT DO NOTHING`,
          [room.id, room.name, room.members[0].id, directKey],
        );
        const directRoom = await client.query<{ id: string }>("SELECT id FROM chat_rooms WHERE direct_key = $1", [directKey]);
        if (!directRoom.rows[0]) throw new Error(`Could not create or find seeded direct room ${room.id}`);
        room.id = directRoom.rows[0].id;
      } else if (room.id !== "general") {
        await client.query(
          `INSERT INTO chat_rooms (id, name, room_type, is_public, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [room.id, room.name, room.type, room.type === "channel", creatorId],
        );
        const existing = await client.query<{ roomType: string; isPublic: boolean }>(
          `SELECT room_type AS "roomType", is_public AS "isPublic" FROM chat_rooms WHERE id = $1`,
          [room.id],
        );
        if (existing.rows[0]?.roomType !== room.type || existing.rows[0]?.isPublic !== (room.type === "channel")) {
          throw new Error(`Seed room ID ${room.id} is already used by a different room`);
        }
      }

      if (room.type !== "channel") {
        for (const member of room.members) {
          await client.query("INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [room.id, member.id]);
        }
      }
    }

    for (const room of rooms) {
      if (!room.id.startsWith("seed-") && !(room.id === "general" && includeGeneralMessages)) continue;
      for (let start = 0; start < messagesPerRoom; start += batchSize) {
        const end = Math.min(messagesPerRoom, start + batchSize);
        const rows = Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          const author = room.members[index % room.members.length];
          return {
            id: deterministicUuid(`message:${room.id}:${index + 1}`),
            userId: author.id,
            content: messageContent(index, room, author),
            createdAt: new Date(Date.now() - (messagesPerRoom - index) * 60_000),
          };
        });
        const result = await client.query(
          `INSERT INTO chat_messages (id, room_id, user_id, sender_id, content, created_at)
           SELECT seed.id, $1, seed.user_id, seed.user_id::text, seed.content, seed.created_at
           FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[])
             AS seed(id, user_id, content, created_at)
           ON CONFLICT (id) DO NOTHING`,
          [room.id, rows.map((row) => row.id), rows.map((row) => row.userId), rows.map((row) => row.content), rows.map((row) => row.createdAt)],
        );
        insertedMessages += result.rowCount ?? 0;
      }

      if (room.id.startsWith("seed-")) {
        await client.query(
          `INSERT INTO room_reads (room_id, user_id, last_read_at)
           SELECT $1, seeded.member_id, NOW() FROM unnest($2::uuid[]) AS seeded(member_id)
           ON CONFLICT (room_id, user_id) DO NOTHING`,
          [room.id, room.members.map((member) => member.id)],
        );
      }
    }

    await client.query("COMMIT");
    const seededRoomCount = rooms.filter((room) => room.id.startsWith("seed-")).length;
    console.log(`Seed complete: ${users.length} users, ${seededRoomCount} seed rooms, ${insertedMessages} new messages.`);
    if (includeGeneralMessages) console.log("Sample messages were also added to the existing general room by request.");
    console.log(`Demo login: ${users[0].email} / ${password}`);
    console.log("Seed data is for local development only. No existing rows were deleted or overwritten.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
