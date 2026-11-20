import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthenticatedRequest } from "../auth/types.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { RoomsService } from "./rooms.service.js";

@Controller()
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(@Inject(RoomsService) private readonly rooms: RoomsService) {}

  @Get("rooms")
  listRooms(@Req() request: AuthenticatedRequest) {
    return this.rooms.listRooms(request.user!.id);
  }

  @Post("presence")
  heartbeat(@Req() request: AuthenticatedRequest) {
    return this.rooms.heartbeat(request.user!.id);
  }

  @Post("rooms/:roomId/read")
  markRead(@Req() request: AuthenticatedRequest, @Param("roomId") roomId: string) {
    return this.rooms.markRead(request.user!.id, roomId);
  }

  @Post("rooms")
  createGroup(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.rooms.createGroup(request.user!.id, body);
  }

  @Post("rooms/direct")
  openDirect(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.rooms.openDirect(request.user!.id, body);
  }

  @Get("users")
  listUsers(@Req() request: AuthenticatedRequest, @Query("search") search?: string) {
    return this.rooms.listUsers(request.user!.id, search);
  }
}
