import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { POSTGRES_POOL } from "../tokens.js";
import type { AuthenticatedUser } from "../auth/types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RoomType = "channel" | "group" | "direct";
type Room = { id: string; name: string; type: RoomType; isPublic: boolean; lastMessage: string | null; lastMessageAt: Date | null; isOnline: boolean | null; lastSeenAt: Date | null; unreadCount: number };

@Injectable()
export class RoomsService {
  constructor(@Inject(POSTGRES_POOL) private readonly postgres: Pool) {}

  async listRooms(userId: string) {
    const result = await this.postgres.query<Room>(
      `SELECT room.id,
              CASE WHEN room.room_type = 'direct' THEN COALESCE(other.display_name, room.name) ELSE room.name END AS name,
              room.room_type AS type,
              room.is_public AS "isPublic",
              latest.content AS "lastMessage",
              latest.created_at AS "lastMessageAt",
              CASE WHEN room.room_type = 'direct' THEN COALESCE(other.is_online, FALSE) ELSE NULL END AS "isOnline",
              CASE WHEN room.room_type = 'direct' THEN other.last_seen_at ELSE NULL END AS "lastSeenAt",
              COALESCE(unread.unread_count, 0)::int AS "unreadCount"
       FROM chat_rooms room
       JOIN users me ON me.id = $1
       LEFT JOIN LATERAL (
         SELECT u.display_name, u.last_seen_at,
                COALESCE(u.last_seen_at >= NOW() - INTERVAL '70 seconds', FALSE) AS is_online
         FROM room_members member
         JOIN users u ON u.id = member.user_id
         WHERE member.room_id = room.id AND member.user_id <> $1
         LIMIT 1
       ) other ON TRUE
       LEFT JOIN room_reads read_state ON read_state.room_id = room.id AND read_state.user_id = $1
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS unread_count
         FROM chat_messages message
         WHERE message.room_id = room.id
           AND message.user_id IS DISTINCT FROM $1::uuid
           AND message.created_at > COALESCE(read_state.last_read_at, me.created_at)
       ) unread ON TRUE
       LEFT JOIN LATERAL (
         SELECT message.content, message.created_at
         FROM chat_messages message
         WHERE message.room_id = room.id
         ORDER BY message.created_at DESC, message.id DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE room.is_public = TRUE
          OR EXISTS (SELECT 1 FROM room_members member WHERE member.room_id = room.id AND member.user_id = $1)
       ORDER BY COALESCE(latest.created_at, room.created_at) DESC, room.id ASC`,
      [userId],
    );
    return { rooms: result.rows };
  }

  async listUsers(userId: string, searchInput?: string) {
    const search = searchInput?.trim() ?? "";
    if (search.length > 80) throw new BadRequestException("search must be at most 80 characters");
    const result = await this.postgres.query<AuthenticatedUser & { isOnline: boolean; lastSeenAt: Date | null }>(
      `SELECT id, email, display_name AS "displayName", last_seen_at AS "lastSeenAt",
              COALESCE(last_seen_at >= NOW() - INTERVAL '70 seconds', FALSE) AS "isOnline"
       FROM users
       WHERE id <> $1 AND ($2 = '' OR display_name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
       ORDER BY display_name ASC
       LIMIT 100`,
      [userId, search],
    );
    return { users: result.rows };
  }

  async heartbeat(userId: string) {
    await this.postgres.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [userId]);
    return { status: "ok" as const };
  }

  async markRead(userId: string, roomIdInput: string) {
    const roomId = this.text(roomIdInput, "roomId", 100);
    const room = await this.postgres.query<{ isPublic: boolean; isMember: boolean }>(
      `SELECT chat_rooms.is_public AS "isPublic",
              EXISTS (SELECT 1 FROM room_members WHERE room_id = chat_rooms.id AND user_id = $2) AS "isMember"
       FROM chat_rooms WHERE id = $1`,
      [roomId, userId],
    );
    if (!room.rows[0]) throw new NotFoundException("Room not found");
    if (!room.rows[0].isPublic && !room.rows[0].isMember) throw new NotFoundException("Room not found");
    await this.postgres.query(
      `INSERT INTO room_reads (room_id, user_id, last_read_at)
       VALUES ($1, $2, COALESCE((SELECT MAX(created_at) FROM chat_messages WHERE room_id = $1), NOW()))
       ON CONFLICT (room_id, user_id) DO UPDATE
       SET last_read_at = GREATEST(room_reads.last_read_at, EXCLUDED.last_read_at)`,
      [roomId, userId],
    );
    return { status: "ok" as const };
  }

  async createGroup(userId: string, input: unknown) {
    const body = this.objectBody(input);
    const name = this.text(body.name, "name", 60);
    if (!Array.isArray(body.memberIds) || body.memberIds.length > 49 || body.memberIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      throw new BadRequestException("memberIds must be a list of up to 49 user IDs");
    }

    const members = [...new Set([userId, ...body.memberIds as string[]])];
    const found = await this.postgres.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1::uuid[])", [members]);
    if (found.rowCount !== members.length) throw new NotFoundException("One or more selected users were not found");

    const id = randomUUID();
    const client = await this.postgres.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO chat_rooms (id, name, room_type, is_public, created_by) VALUES ($1, $2, 'group', FALSE, $3)",
        [id, name, userId],
      );
      await client.query(
        "INSERT INTO room_members (room_id, user_id) SELECT $1, unnest($2::uuid[])",
        [id, members],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { room: { id, name, type: "group" as const, isPublic: false } };
  }

  async openDirect(userId: string, input: unknown) {
    const body = this.objectBody(input);
    const otherUserId = body.userId;
    if (typeof otherUserId !== "string" || !UUID_PATTERN.test(otherUserId)) {
      throw new BadRequestException("A valid userId is required");
    }
    if (otherUserId === userId) throw new BadRequestException("You cannot start a direct conversation with yourself");

    const found = await this.postgres.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [otherUserId]);
    if (found.rowCount !== 1) throw new NotFoundException("User not found");

    const directKey = [userId, otherUserId].sort().join(":");
    const id = randomUUID();
    const client = await this.postgres.connect();
    let roomId: string;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO chat_rooms (id, name, room_type, is_public, created_by, direct_key)
         VALUES ($1, 'Direct message', 'direct', FALSE, $2, $3)
         ON CONFLICT (direct_key) DO NOTHING`,
        [id, userId, directKey],
      );
      const room = await client.query<{ id: string }>("SELECT id FROM chat_rooms WHERE direct_key = $1", [directKey]);
      roomId = room.rows[0].id;
      await client.query(
        "INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING",
        [roomId, userId, otherUserId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const other = await this.postgres.query<{ displayName: string }>(`SELECT display_name AS "displayName" FROM users WHERE id = $1`, [otherUserId]);
    return { room: { id: roomId!, name: other.rows[0].displayName, type: "direct" as const, isPublic: false } };
  }

  private objectBody(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new BadRequestException("Request body must be a JSON object");
    return input as Record<string, unknown>;
  }

  private text(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
      throw new BadRequestException(`${field} must be between 1 and ${maxLength} characters`);
    }
    return value.trim();
  }
}
