import "reflect-metadata";
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { Pool } from "pg";

type TestSocket = Socket;
type Session = {
  accessToken: string;
  user: { id: string; email: string; displayName: string };
};
type ApiReply = { response: Response; body: any };

const migrationFiles = [
  "001_create_chat_messages.sql",
  "002_create_users.sql",
  "003_rooms_and_memberships.sql",
  "004_presence_and_reads.sql",
];
const testPassword = "Integration-Test-Password-2026!";
const sockets: TestSocket[] = [];
let testPool: Pool | undefined;
let databasePrepared = false;
let app: INestApplication | undefined;
let apiUrl = "";

async function requestJson(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiReply> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  return { response, body };
}

async function createAccount(displayName: string): Promise<Session> {
  const email = `${displayName.toLowerCase().replace(/\s+/g, ".")}-${randomUUID()}@example.test`;
  const { response, body } = await requestJson("/auth/register", {
    method: "POST",
    body: { email, displayName, password: testPassword },
  });
  assert.equal(response.status, 201, `register ${displayName}: ${JSON.stringify(body)}`);
  assert.equal(typeof body.accessToken, "string");
  return body as Session;
}

function connectSocket(token?: string): Promise<TestSocket> {
  const socket = io(apiUrl, {
    autoConnect: false,
    auth: token ? { token } : {},
    reconnection: false,
    timeout: 5000,
    transports: ["websocket"],
  });
  sockets.push(socket);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Timed out waiting for Socket.IO connection"));
    }, 7000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.connect();
  });
}

function emitAck<T>(socket: TestSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error: Error | null, result: T) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function waitForEvent<T>(socket: TestSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 7000);
    socket.once(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function resetTestDatabase() {
  if (!testPool) return;
  await testPool.query("BEGIN");
  try {
    await testPool.query("TRUNCATE TABLE chat_messages, room_reads, room_members, chat_rooms, users CASCADE");
    await testPool.query(
      "INSERT INTO chat_rooms (id, name, room_type, is_public) VALUES ('general', 'general', 'channel', TRUE)",
    );
    await testPool.query("COMMIT");
  } catch (error) {
    await testPool.query("ROLLBACK");
    throw error;
  }
}

before(async () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error("Set TEST_DATABASE_URL to a dedicated local database whose name ends in _test");
  }

  const database = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  if (!['localhost', '127.0.0.1', '::1'].includes(database.hostname) || !databaseName.endsWith("_test")) {
    throw new Error("Refusing to run integration tests: TEST_DATABASE_URL must point to localhost and a database ending in _test");
  }

  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString("base64");
  process.env.REDIS_URL ??= "redis://localhost:6379";

  testPool = new Pool({ connectionString: testDatabaseUrl });
  for (const migration of migrationFiles) {
    const path = fileURLToPath(new URL(`../migrations/${migration}`, import.meta.url));
    await testPool.query(await readFile(path, "utf8"));
  }
  await resetTestDatabase();
  databasePrepared = true;

  const { AppModule } = await import("../src/app.module.js");
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  if (app) await app.close();
  if (databasePrepared) await resetTestDatabase();
  if (testPool) await testPool.end();
});

test("REST authentication, private-room access, read state, and Socket.IO messaging", async () => {
  const anonymousRooms = await requestJson("/rooms");
  assert.equal(anonymousRooms.response.status, 401);

  const alice = await createAccount("Alice Example");
  const bob = await createAccount("Bob Example");
  const carol = await createAccount("Carol Example");

  const invalidLogin = await requestJson("/auth/login", {
    method: "POST",
    body: { email: alice.user.email, password: "incorrect-password" },
  });
  assert.equal(invalidLogin.response.status, 401);

  const invalidToken = await requestJson("/rooms", { token: "not-a-valid-token" });
  assert.equal(invalidToken.response.status, 401);

  const search = await requestJson(`/users?search=${encodeURIComponent("Bob Example")}`, { token: alice.accessToken });
  assert.equal(search.response.status, 200);
  assert.ok(search.body.users.some((user: { id: string }) => user.id === bob.user.id));
  assert.ok(search.body.users.every((user: { id: string }) => user.id !== alice.user.id));
  assert.ok(search.body.users.every((user: Record<string, unknown>) => !("passwordHash" in user)));

  const groupReply = await requestJson("/rooms", {
    method: "POST",
    token: alice.accessToken,
    body: { name: "Private integration group", memberIds: [bob.user.id] },
  });
  assert.equal(groupReply.response.status, 201);
  const groupId = groupReply.body.room.id as string;

  const carolGroupMessage = await requestJson("/messages", {
    method: "POST",
    token: carol.accessToken,
    body: { roomId: groupId, content: "This should be denied" },
  });
  assert.equal(carolGroupMessage.response.status, 403);

  const aliceDirect = await requestJson("/rooms/direct", {
    method: "POST",
    token: alice.accessToken,
    body: { userId: bob.user.id },
  });
  const bobDirect = await requestJson("/rooms/direct", {
    method: "POST",
    token: bob.accessToken,
    body: { userId: alice.user.id },
  });
  assert.equal(aliceDirect.response.status, 201);
  assert.equal(bobDirect.response.status, 201);
  assert.equal(aliceDirect.body.room.id, bobDirect.body.room.id, "direct conversation should be reused");
  const directId = aliceDirect.body.room.id as string;

  const aliceSocket = await connectSocket(alice.accessToken);
  const bobSocket = await connectSocket(bob.accessToken);
  const carolSocket = await connectSocket(carol.accessToken);
  for (const socket of [aliceSocket, bobSocket]) {
    const ack = await emitAck<{ ok: boolean }>(socket, "room:join", { roomId: directId });
    assert.equal(ack.ok, true);
  }

  const carolGroupJoin = await emitAck<{ ok: boolean }>(carolSocket, "room:join", { roomId: groupId });
  assert.equal(carolGroupJoin.ok, false, "non-member must not join a private Socket.IO room");

  const firstBobEvent = waitForEvent<{ id: string; roomId: string; content: string }>(bobSocket, "message:new");
  const restMessage = await requestJson("/messages", {
    method: "POST",
    token: alice.accessToken,
    body: { roomId: directId, content: "REST message reaches the other member" },
  });
  assert.equal(restMessage.response.status, 201);
  assert.equal((await firstBobEvent).content, "REST message reaches the other member");

  const secondBobEvent = waitForEvent<{ id: string; roomId: string; content: string }>(bobSocket, "message:new");
  const socketAck = await emitAck<{ ok: boolean; message: { id: string; content: string } }>(
    aliceSocket,
    "message:send",
    { roomId: directId, content: "Socket.IO message reaches the other member" },
  );
  assert.equal(socketAck.ok, true);
  assert.equal((await secondBobEvent).id, socketAck.message.id);

  const history = await requestJson(`/messages?roomId=${encodeURIComponent(directId)}&limit=10`, {
    token: bob.accessToken,
  });
  assert.equal(history.response.status, 200);
  assert.equal(history.body.messages.length, 2);

  const bobRoomsBeforeRead = await requestJson("/rooms", { token: bob.accessToken });
  const directBeforeRead = bobRoomsBeforeRead.body.rooms.find((room: { id: string }) => room.id === directId);
  assert.ok(directBeforeRead.unreadCount >= 1);

  const markRead = await requestJson(`/rooms/${encodeURIComponent(directId)}/read`, {
    method: "POST",
    token: bob.accessToken,
  });
  assert.equal(markRead.response.status, 201);
  const bobRoomsAfterRead = await requestJson("/rooms", { token: bob.accessToken });
  const directAfterRead = bobRoomsAfterRead.body.rooms.find((room: { id: string }) => room.id === directId);
  assert.equal(directAfterRead.unreadCount, 0);

  const heartbeat = await requestJson("/presence", { method: "POST", token: bob.accessToken });
  assert.equal(heartbeat.response.status, 201);
  const aliceRooms = await requestJson("/rooms", { token: alice.accessToken });
  const aliceDirectRoom = aliceRooms.body.rooms.find((room: { id: string }) => room.id === directId);
  assert.equal(aliceDirectRoom.isOnline, true);

  const carolRooms = await requestJson("/rooms", { token: carol.accessToken });
  assert.ok(!carolRooms.body.rooms.some((room: { id: string }) => room.id === groupId));

  const rejectedSocket = io(apiUrl, {
    autoConnect: false,
    auth: { token: "not-a-valid-token" },
    reconnection: false,
    timeout: 5000,
    transports: ["websocket"],
  });
  sockets.push(rejectedSocket);
  const connectionError = new Promise<Error>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Expected Socket.IO auth rejection")), 7000);
    rejectedSocket.once("connect_error", (error) => {
      clearTimeout(timeout);
      resolve(error);
    });
    rejectedSocket.once("connect", () => {
      clearTimeout(timeout);
      reject(new Error("Socket.IO accepted an invalid token"));
    });
    rejectedSocket.connect();
  });
  assert.match((await connectionError).message, /token/i);
  rejectedSocket.disconnect();
});
