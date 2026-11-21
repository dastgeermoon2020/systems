import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { POSTGRES_POOL } from "../tokens.js";

type NewMessage = { roomId: string; content: string };
type Sender = { id: string; displayName: string };

@Injectable()
export class MessagesService {
  constructor(@Inject(POSTGRES_POOL) private readonly postgres: Pool) {}

  async create(user: Sender, input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new BadRequestException("Request body must be a JSON object");
    }

    const body = input as Record<string, unknown>;
    const roomId = this.requiredText(body.roomId, "roomId", 100);
    const content = this.requiredText(body.content, "content", 4000);
    await this.assertRoomAccess(roomId, user.id);

    const result = await this.postgres.query<NewMessage & { id: string; createdAt: Date }>(
      `INSERT INTO chat_messages (room_id, user_id, sender_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, room_id AS "roomId", sender_id AS "senderId", content,
                 created_at AS "createdAt"`,
      [roomId, user.id, user.id, content],
    );

    return { message: { ...result.rows[0], senderName: user.displayName } };
  }

  async list(roomIdInput: string, userId: string, limitInput?: string) {
    const roomId = this.requiredText(roomIdInput, "roomId", 100);
    const limit = limitInput === undefined ? 50 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("limit must be an integer between 1 and 100");
    }
    await this.assertRoomAccess(roomId, userId);

    const result = await this.postgres.query<NewMessage & { id: string; createdAt: Date }>(
      `SELECT recent.id, recent.room_id AS "roomId", recent.sender_id AS "senderId",
              COALESCE(users.display_name, recent.sender_id) AS "senderName",
              recent.content, recent.created_at AS "createdAt"
       FROM (
         SELECT id, room_id, sender_id, user_id, content, created_at
         FROM chat_messages
         WHERE room_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) recent
       LEFT JOIN users ON users.id = recent.user_id
       ORDER BY recent.created_at ASC, recent.id ASC`,
      [roomId, limit],
    );

    return { messages: result.rows };
  }

  async assertRoomAccess(roomId: string, userId: string) {
    const result = await this.postgres.query<{ isPublic: boolean; isMember: boolean }>(
      `SELECT room.is_public AS "isPublic",
              EXISTS (SELECT 1 FROM room_members WHERE room_id = room.id AND user_id = $2) AS "isMember"
       FROM chat_rooms room WHERE room.id = $1`,
      [roomId, userId],
    );
    const room = result.rows[0];
    if (!room) throw new NotFoundException("Room not found");
    if (!room.isPublic && !room.isMember) throw new ForbiddenException("You are not a member of this room");
  }

  async roomMemberIds(roomId: string): Promise<string[]> {
    const result = await this.postgres.query<{ userId: string }>(
      "SELECT user_id AS \"userId\" FROM room_members WHERE room_id = $1",
      [roomId],
    );
    return result.rows.map((row) => row.userId);
  }

  private requiredText(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
      throw new BadRequestException(`${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value;
  }
}
