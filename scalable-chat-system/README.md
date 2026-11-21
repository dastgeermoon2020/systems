# DMChat

A full-stack chat application under active development. The current MVP supports account registration and login, a shared `#general` channel, private group conversations, and one-to-one direct messages.

## Implemented features

### Accounts and authentication

- Register with an email address, display name, and password.
- Sign in with email and password.
- Passwords are stored as password hashes; plain-text passwords are not stored.
- Successful registration and login return a signed JWT access token.
- Access tokens use HS256 and expire after 15 minutes.
- Authenticated API requests use `Authorization: Bearer <token>`.
- The web app keeps the token in the current browser tab's `sessionStorage` and clears it on sign-out.
- The interface supports dark and light themes, starts in dark mode, and remembers the selected theme in the browser.
- A repeatable local seeder creates demo accounts, channels, groups, direct chats, and messages without deleting or overwriting existing rows.

There is no email verification, password reset, refresh-token flow, or server-side token revocation yet. Users sign in again after their access token expires.

### Rooms and conversations

- `#general` is a shared channel available to all signed-in users.
- Create private group conversations and choose members from the user directory. The creator is added automatically; up to 49 other users can be selected.
- Start a private one-to-one conversation with another registered user. The same two-person conversation is reused if either person opens it again.
- Search the user directory by display name or email. The API returns at most 100 matching users and excludes the signed-in user.
- Show online dots for active users and a last-seen time for offline users. The browser sends a presence heartbeat every 20 seconds while visible; a user is considered offline after 70 seconds without one.
- The API checks room membership before allowing users to read or send messages in private rooms.

Dynamic public channel creation, adding or removing members after a group is created, and room deletion are not implemented yet.

### Messages

- Send messages to the selected channel, group, or direct conversation.
- Load the most recent messages in a room. The API defaults to 50 messages and accepts a limit from 1 to 100.
- Show per-room unread message counts. Opening a conversation marks its current messages as read; unread counts refresh with the conversation list.
- Message content is limited to 4,000 characters.
- Deliver new messages over an authenticated Socket.IO connection. Messages are saved to PostgreSQL before the server broadcasts them to the room.
- Keep REST history and sending as a fallback when a live socket is disconnected. The web app polls messages every 3 seconds only while disconnected; the conversation list refreshes every 10 seconds.

### Health and service connections

- `GET /health` reports that the API process is responding.
- `GET /ready` checks PostgreSQL and Redis and reports whether both are reachable.
- PostgreSQL stores users, rooms, room membership, and messages.
- Redis is started by Docker Compose and checked by the readiness endpoint. It is not yet used for chat messages, caching, pub/sub, or queues.

## Technology

| Area                 | Current implementation                        |
| -------------------- | --------------------------------------------- |
| Web                  | Next.js 16 App Router, React, TypeScript      |
| API                  | NestJS 12, TypeScript, Express platform       |
| Authentication       | JWT access tokens and NestJS password hashing |
| Database             | PostgreSQL 17                                 |
| Redis                | Redis 7; currently used for readiness checks  |
| Real-time messaging  | Socket.IO over the NestJS WebSocket gateway   |
| Local infrastructure | Docker Compose                                |

## Project structure

```text
apps/
  api/
    migrations/       SQL migrations for messages, users, rooms, and membership
    src/auth/         Registration, login, JWT guard
    src/messages/     REST endpoints, Socket.IO gateway, and room access checks
    src/scripts/      Repeatable local development data seeder
    src/rooms/        Room, group, direct-message, and user-directory endpoints
  web/
    app/              Next.js chat interface

docs/
  architecture/       Architecture documentation area
  benchmarks/         Benchmark documentation area
infrastructure/
  prometheus/         Prometheus configuration placeholder
  grafana/provisioning/
load-tests/
  scenarios/          Grafana k6 Socket.IO workload
  results/            Load-test result area
```

The architecture/benchmark and monitoring directories are scaffolding. A modest Grafana k6 Socket.IO baseline is available; larger load-test scenarios and result tracking remain future work.

## Requirements

- Docker Desktop with Docker Compose
- Node.js 22.12 or newer in the Node 22 line (or Node.js 20.19 or newer)
- npm

## Local setup

Run commands from the project root, `scalable-chat-system`, unless a step says otherwise.

### 1. Start PostgreSQL and Redis

```bash
docker compose up -d
docker compose ps
```

Wait for both `chat-postgres` and `chat-redis` to show `healthy`.

### 2. Apply database migrations

Apply migrations in order. They use `IF NOT EXISTS` where applicable, so they can also be re-run against this development database:

```bash
docker compose exec -T postgres psql -U chatadmin -d chat_system < apps/api/migrations/001_create_chat_messages.sql
docker compose exec -T postgres psql -U chatadmin -d chat_system < apps/api/migrations/002_create_users.sql
docker compose exec -T postgres psql -U chatadmin -d chat_system < apps/api/migrations/003_rooms_and_memberships.sql
docker compose exec -T postgres psql -U chatadmin -d chat_system < apps/api/migrations/004_presence_and_reads.sql
```

These migrations add tables, columns, indexes, and room relationships. Migration 004 adds last-seen and read-marker storage and initializes existing rooms as read so old messages do not suddenly appear unread. The migrations do not drop the PostgreSQL volume. Do not use `docker compose down -v` if you want to keep the local database data.

### 3. Configure and start the API

In a terminal:

```bash
cd apps/api
npm install
```

For a new local setup, copy the sample environment file once:

```bash
cp ../../.env.example .env
```

If `apps/api/.env` already exists, keep it and update only the values you need. Set `JWT_SECRET` to a random secret of at least 32 bytes. You can generate one with:

```bash
openssl rand -base64 32
```

Put the generated value in `apps/api/.env`; do not commit or share that file. The sample `DATABASE_URL` is configured for the local Compose database. The API listens on port `3000` by default and allows the web app at `http://localhost:3001` by default.

Start the API:

```bash
npm run dev
```

### 4. Install and start the web app

In a separate terminal:

```bash
cd ~/Desktop/systems/scalable-chat-system/apps/web
npm install
```

The web app defaults to `http://localhost:3000` for the API. To configure it explicitly, copy `apps/web/.env.example` to `.env.local` and set `NEXT_PUBLIC_API_URL`.

Start the frontend:

```bash
npm run dev
```

Open [http://localhost:3001](http://localhost:3001), then register or sign in. To try direct messages or groups, create a second account with a different email address in another browser session.

### Optional: seed local development data

Run this from `apps/api` after migrations have been applied and the local `.env` is configured:

```bash
npm run seed:local
```

The default seed creates 12 demo accounts, 2 public channels, 3 private groups, 3 direct conversations, and 100 messages in each of those 8 seeded rooms. It leaves the existing `general` room and its messages alone. It is safe to re-run: stable IDs prevent duplicate demo rows, and it does not delete or overwrite existing users, rooms, or messages. The first demo login is `demo001@example.com` with password `DMChat-Seed-Only-2026!`; use this only with a local development database.

For a larger local dataset, adjust the counts before the command:

```bash
SEED_USER_COUNT=50 \
SEED_CHANNEL_COUNT=10 \
SEED_GROUP_COUNT=10 \
SEED_DIRECT_COUNT=25 \
SEED_MESSAGES_PER_ROOM=1000 \
npm run seed:local
```

Set `SEED_INCLUDE_GENERAL=true` only if you also want sample messages added to the existing `#general` channel.

For local development only, the Compose and sample environment files contain placeholder database credentials that match each other. Replace them and use managed secrets before deploying outside a local machine.

### API and WebSocket integration tests

The integration suite starts the real NestJS API on a temporary local port and exercises REST authentication, room permissions, direct/group conversations, message history and read state, presence, and authenticated Socket.IO delivery. It requires healthy PostgreSQL and Redis services.

Create a separate test database once:

```bash
docker compose exec -T postgres psql -U chatadmin -d postgres -c "CREATE DATABASE chat_system_test;"
```

In `apps/api/.env`, set `TEST_DATABASE_URL` to that database using the same local username and password as `DATABASE_URL`. The test runner refuses URLs that do not point to localhost and a database name ending in `_test`. It applies migrations and clears only this dedicated test database before and after the run; it does not use the development `chat_system` database.

Install API dependencies and run the suite from `apps/api`:

```bash
cd apps/api
npm install
npm run test:e2e
```

### Optional: run the Grafana k6 Socket.IO baseline

After seeding test data and starting the API, follow [the load-test guide](load-tests/README.md) to run a modest single-instance baseline with Grafana k6.

## API reference

Except for health checks and account registration/login, endpoints require a JWT in the `Authorization` header.

| Method | Path                                | Purpose                                                     | Access                       |
| ------ | ----------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| `GET`  | `/health`                           | API process health                                          | Public                       |
| `GET`  | `/ready`                            | PostgreSQL and Redis readiness                              | Public                       |
| `POST` | `/auth/register`                    | Create an account; body: `email`, `displayName`, `password` | Public                       |
| `POST` | `/auth/login`                       | Sign in; body: `email`, `password`                          | Public                       |
| `GET`  | `/users?search=...`                 | Search users by name or email                               | Bearer token                 |
| `POST` | `/presence`                          | Update the signed-in user's last-seen time                 | Bearer token                 |
| `GET`  | `/rooms`                            | List public channels and rooms the user belongs to          | Bearer token                 |
| `POST` | `/rooms/:roomId/read`               | Mark the current messages in a room as read                 | Bearer token and room access |
| `POST` | `/rooms`                            | Create a private group; body: `name`, `memberIds`           | Bearer token                 |
| `POST` | `/rooms/direct`                     | Open or create a one-to-one room; body: `userId`            | Bearer token                 |
| `GET`  | `/messages?roomId=general&limit=50` | List recent messages in a room                              | Bearer token and room access |
| `POST` | `/messages`                         | Send a message; body: `roomId`, `content`                   | Bearer token and room access |

### Socket.IO events

Connect to the API URL with the access token in the Socket.IO handshake: `{ auth: { token } }`. Available client events are `room:join` with `{ roomId }`, `room:leave` with `{ roomId }`, and `message:send` with `{ roomId, content }`. The server acknowledges each request. New messages arrive as `message:new`; members of private rooms receive `room:updated` notifications so their unread counts can refresh.

Example message body:

```json
{
  "roomId": "general",
  "content": "Hello from the chat app"
}
```

The sender identity is taken from the verified access token; clients must not supply a `senderId`.

## Development status

This is an MVP, not a production deployment. Broader automated API test coverage, larger load-test scenarios and result tracking, Prometheus/Grafana dashboards, a Redis Socket.IO adapter for multi-instance broadcasts, email verification, password recovery, and production deployment configuration remain future work. The current Socket.IO gateway broadcasts within one API instance.
