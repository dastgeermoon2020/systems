import { ConflictException, Inject, Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { PasswordHasher } from "@nestjs/authentication";
import { JwtService } from "@nestjs/jwt";
import { Pool } from "pg";
import { POSTGRES_POOL } from "../tokens.js";
import type { AuthenticatedUser } from "./types.js";

type UserRow = AuthenticatedUser & { passwordHash?: string };
const TOKEN_LIFETIME_SECONDS = 900;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class AuthService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly postgres: Pool,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async register(input: unknown) {
    const body = this.objectBody(input);
    const email = this.email(body.email);
    const displayName = this.text(body.displayName, "displayName", 80);
    const password = this.password(body.password);
    const passwordHash = await this.passwordHasher.hash(password);

    let user: AuthenticatedUser;
    try {
      const result = await this.postgres.query<AuthenticatedUser>(
        `INSERT INTO users (email, display_name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name AS "displayName"`,
        [email, displayName, passwordHash],
      );
      user = result.rows[0];
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException("An account with this email already exists");
      throw error;
    }

    return this.issueToken(user);
  }

  async login(input: unknown) {
    const body = this.objectBody(input);
    const email = this.email(body.email);
    const password = this.loginPassword(body.password);
    const result = await this.postgres.query<UserRow>(
      `SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash"
       FROM users WHERE email = $1`,
      [email],
    );
    const user = result.rows[0];
    const valid = await this.passwordHasher.verify(password, user?.passwordHash);
    if (!user || !valid) throw new UnauthorizedException("Email or password is incorrect");
    return this.issueToken(user);
  }

  private async issueToken(user: AuthenticatedUser) {
    const accessToken = await this.jwt.signAsync(
      { email: user.email, displayName: user.displayName },
      {
        subject: user.id,
        issuer: process.env.JWT_ISSUER ?? "scalable-chat-system",
        audience: process.env.JWT_AUDIENCE ?? "scalable-chat-api",
        expiresIn: TOKEN_LIFETIME_SECONDS,
        algorithm: "HS256",
      },
    );
    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: TOKEN_LIFETIME_SECONDS,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }

  private objectBody(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new BadRequestException("Request body must be a JSON object");
    }
    return input as Record<string, unknown>;
  }

  private email(value: unknown): string {
    if (typeof value !== "string") throw new BadRequestException("A valid email is required");
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) {
      throw new BadRequestException("A valid email is required");
    }
    return normalized;
  }

  private text(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
      throw new BadRequestException(`${field} must be between 1 and ${maxLength} characters`);
    }
    return value.trim();
  }

  private password(value: unknown): string {
    const password = this.loginPassword(value);
    if (password.length < 12) throw new BadRequestException("Password must be at least 12 characters");
    return password;
  }

  private loginPassword(value: unknown): string {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096 || value.length === 0) {
      throw new BadRequestException("Password is required and must be at most 4096 bytes");
    }
    return value;
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
  }
}
