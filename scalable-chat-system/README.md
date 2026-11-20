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
- The web app refreshes messages every 3 seconds and the conversation list every 10 seconds. This is polling; WebSocket-based live updates are not implemented yet.

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
| Local infrastructure | Docker Compose                                |

## Project structure

```text
apps/
  api/
    migrations/       SQL migrations for messages, users, rooms, and membership
    src/auth/         Registration, login, JWT guard
    src/messages/     Message endpoints and room access checks
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
  scenarios/          Load-test scenario area
  results/            Load-test result area
```

The architecture/benchmark, monitoring, and load-test directories are scaffolding; monitoring configuration, seeded test data, and load-test scenarios have not been implemented yet.

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

For local development only, the Compose and sample environment files contain placeholder database credentials that match each other. Replace them and use managed secrets before deploying outside a local machine.

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

Example message body:

```json
{
  "roomId": "general",
  "content": "Hello from the chat app"
}
```

The sender identity is taken from the verified access token; clients must not supply a `senderId`.

## Development status

This is an MVP, not a production deployment. Automated API tests, data seeding, load testing, Prometheus/Grafana dashboards, WebSockets, email verification, password recovery, and production deployment configuration remain future work.
