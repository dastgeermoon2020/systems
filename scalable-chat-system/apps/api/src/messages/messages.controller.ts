import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { MessagesService } from "./messages.service.js";
import { MessagesGateway } from "./messages.gateway.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import type { AuthenticatedRequest } from "../auth/types.js";

@Controller("messages")
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(
    @Inject(MessagesService) private readonly messagesService: MessagesService,
    @Inject(MessagesGateway) private readonly messagesGateway: MessagesGateway,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const result = await this.messagesService.create(request.user!, body);
    this.messagesGateway.broadcast(result.message.roomId, result.message);
    return result;
  }

  @Get()
  list(@Query("roomId") roomId: string, @Req() request: AuthenticatedRequest, @Query("limit") limit?: string) {
    return this.messagesService.list(roomId, request.user!.id, limit);
  }
}
