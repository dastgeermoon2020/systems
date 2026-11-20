import { Module } from "@nestjs/common";
import { PasswordHasher } from "@nestjs/authentication";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
          throw new Error("JWT_SECRET must be set and contain at least 32 bytes");
        }
        return { secret, signOptions: { algorithm: "HS256" as const } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: PasswordHasher, useFactory: () => new PasswordHasher() }],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
