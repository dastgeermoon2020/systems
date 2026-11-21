import {
  Ack,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Inject } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Server, Socket } from "socket.io";
import { MessagesService } from "./messages.service.js";
import type { AuthenticatedUser } from "../auth/types.js";

type SocketData = { user?: AuthenticatedUser; expiresAt?: number; expirationTimer?: NodeJS.Timeout };
type ChatSocket = Socket<any, any, any, SocketData>;
type TokenClaims = { sub?: string; email?: string; displayName?: string; exp?: number };
type AckResult = { ok: boolean; roomId?: string; message?: unknown; error?: string };

@WebSocketGateway({
  cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3001" },
  maxHttpBufferSize: 16 * 1024,
})
export class MessagesGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(MessagesService) private readonly messages: MessagesService,
  ) {}

  afterInit(server: Server) {
    server.use((socket, next) => {
      void this.authenticate(socket as ChatSocket, next);
    });
  }

  handleConnection(client: ChatSocket) {
    const userId = client.data.user?.id;
    if (userId) void client.join(`user:${userId}`);
    const expiresAt = client.data.expiresAt;
    if (expiresAt) {
      const remaining = Math.max(0, expiresAt * 1000 - Date.now());
      client.data.expirationTimer = setTimeout(() => client.disconnect(true), remaining);
      client.data.expirationTimer.unref?.();
    }
  }

  handleDisconnect(client: ChatSocket) {
    if (client.data.expirationTimer) clearTimeout(client.data.expirationTimer);
  }

  @SubscribeMessage("room:join")
  async joinRoom(@ConnectedSocket() client: ChatSocket, @MessageBody() input: unknown): Promise<AckResult> {
    const roomId = this.roomId(input);
    if (!roomId) return { ok: false, error: "A valid roomId is required" };
    try {
      await this.messages.assertRoomAccess(roomId, this.user(client).id);
      await client.join(roomId);
      return { ok: true, roomId };
    } catch {
      return { ok: false, error: "You do not have access to this room" };
    }
  }

  @SubscribeMessage("room:leave")
  async leaveRoom(@ConnectedSocket() client: ChatSocket, @MessageBody() input: unknown): Promise<AckResult> {
    const roomId = this.roomId(input);
    if (!roomId) return { ok: false, error: "A valid roomId is required" };
    await client.leave(roomId);
    return { ok: true, roomId };
  }

  @SubscribeMessage("message:send")
  async sendMessage(@ConnectedSocket() client: ChatSocket, @MessageBody() input: unknown): Promise<AckResult> {
    try {
      const result = await this.messages.create(this.user(client), input);
      this.broadcast(result.message.roomId, result.message);
      return { ok: true, roomId: result.message.roomId, message: result.message };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Message could not be sent" };
    }
  }

  broadcast(roomId: string, message: unknown) {
    this.server.to(roomId).emit("message:new", message);
    void this.messages.roomMemberIds(roomId).then((userIds) => {
      for (const userId of userIds) {
        this.server.to(`user:${userId}`).emit("room:updated", { roomId });
      }
    }).catch((error: unknown) => {
      console.error("Could not notify room members:", error);
    });
  }

  private async authenticate(client: ChatSocket, next: (error?: Error) => void) {
    const token = typeof client.handshake.auth?.token === "string" ? client.handshake.auth.token.trim() : "";
    if (!token) return next(new Error("Bearer access token required"));

    try {
      const claims = await this.jwt.verifyAsync<TokenClaims>(token, {
        algorithms: ["HS256"],
        issuer: process.env.JWT_ISSUER ?? "scalable-chat-system",
        audience: process.env.JWT_AUDIENCE ?? "scalable-chat-api",
      });
      if (!claims.sub || !claims.email || !claims.displayName || !claims.exp) {
        return next(new Error("Invalid access token"));
      }
      client.data.user = { id: claims.sub, email: claims.email, displayName: claims.displayName };
      client.data.expiresAt = claims.exp;
      next();
    } catch {
      next(new Error("Invalid or expired access token"));
    }
  }

  private user(client: ChatSocket): AuthenticatedUser {
    if (!client.data.user) throw new Error("Unauthorized socket");
    return client.data.user;
  }

  private roomId(input: unknown): string | null {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const value = (input as Record<string, unknown>).roomId;
    return typeof value === "string" && value.trim().length > 0 && value.length <= 100 ? value.trim() : null;
  }
}
