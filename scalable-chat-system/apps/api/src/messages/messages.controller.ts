import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { MessagesService } from "./messages.service.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import type { AuthenticatedRequest } from "../auth/types.js";

@Controller("messages")
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly messagesService: MessagesService) {}

  @Post()
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.messagesService.create(request.user!, body);
  }

  @Get()
  list(@Query("roomId") roomId: string, @Req() request: AuthenticatedRequest, @Query("limit") limit?: string) {
    return this.messagesService.list(roomId, request.user!.id, limit);
  }
}
