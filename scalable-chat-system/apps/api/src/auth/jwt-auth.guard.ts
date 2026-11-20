import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { AuthenticatedRequest, AuthenticatedUser } from "./types.js";

type AccessTokenClaims = { sub?: string; email?: string; displayName?: string };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) throw new UnauthorizedException("Bearer access token required");

    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        algorithms: ["HS256"],
        issuer: process.env.JWT_ISSUER ?? "scalable-chat-system",
        audience: process.env.JWT_AUDIENCE ?? "scalable-chat-api",
      });

      if (!claims.sub || !claims.email || !claims.displayName) {
        throw new UnauthorizedException("Invalid access token");
      }
      request.user = { id: claims.sub, email: claims.email, displayName: claims.displayName } satisfies AuthenticatedUser;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }
}
