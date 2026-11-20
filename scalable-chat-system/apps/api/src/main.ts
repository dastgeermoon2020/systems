import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3001",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, process.env.API_HOST ?? "0.0.0.0");
}

void bootstrap();
