import { Inject, Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { Pool } from "pg";
import { createClient } from "redis";
import { POSTGRES_POOL, REDIS_CLIENT } from "./tokens.js";

type RedisClient = ReturnType<typeof createClient>;

@Injectable()
export class AppService implements OnModuleDestroy {
  constructor(
    @Inject(POSTGRES_POOL) private readonly postgres: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  health() {
    return { status: "ok" };
  }

  async ready() {
    const checks: { postgres: "ok" | "unavailable"; redis: "ok" | "unavailable" } = {
      postgres: "ok",
      redis: "ok",
    };

    try {
      await this.postgres.query("SELECT 1");
    } catch {
      checks.postgres = "unavailable";
    }

    try {
      await this.redis.ping();
    } catch {
      checks.redis = "unavailable";
    }

    if (checks.postgres !== "ok" || checks.redis !== "ok") {
      throw new ServiceUnavailableException({ status: "not_ready", checks });
    }

    return { status: "ready", checks };
  }

  async onModuleDestroy() {
    await Promise.all([this.postgres.end(), this.redis.quit()]);
  }
}
