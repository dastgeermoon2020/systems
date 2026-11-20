import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { AuthModule } from "./auth/auth.module.js";
import { AppService } from "./app.service.js";
import { InfrastructureModule } from "./infrastructure.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { RoomsModule } from "./rooms/rooms.module.js";

@Module({
  imports: [InfrastructureModule, AuthModule, MessagesModule, RoomsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
