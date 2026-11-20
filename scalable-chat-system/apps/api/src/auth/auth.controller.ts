import { Body, Controller, Inject, Post } from "@nestjs/common";
import { AuthService } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("register")
  register(@Body() body: unknown) {
    return this.authService.register(body);
  }

  @Post("login")
  login(@Body() body: unknown) {
    return this.authService.login(body);
  }
}
