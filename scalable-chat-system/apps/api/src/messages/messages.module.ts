import { Module } from "@nestjs/common";
import { MessagesController } from "./messages.controller.js";
import { MessagesService } from "./messages.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";

@Module({
  imports: [AuthModule],
  controllers: [MessagesController],
  providers: [MessagesService, JwtAuthGuard],
})
export class MessagesModule {}
