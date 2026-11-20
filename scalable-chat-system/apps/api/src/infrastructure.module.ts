import { Global, Module } from "@nestjs/common";
import { Pool } from "pg";
import { createClient } from "redis";
import { POSTGRES_POOL, REDIS_CLIENT } from "./tokens.js";

@Global()
@Module({
  providers: [
    {
      provide: POSTGRES_POOL,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) throw new Error("DATABASE_URL is required");
        return new Pool({ connectionString });
      },
    },
    {
      provide: REDIS_CLIENT,
      useFactory: async () => {
        const client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
        client.on("error", (error) => console.error("Redis client error:", error));
        await client.connect();
        return client;
      },
    },
  ],
  exports: [POSTGRES_POOL, REDIS_CLIENT],
})
export class InfrastructureModule {}
