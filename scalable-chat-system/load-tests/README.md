# DMChat load tests with Grafana k6

This folder contains a local Grafana k6 baseline for DMChat's Socket.IO gateway. It uses k6's WebSocket transport and the Socket.IO/Engine.IO packet framing used by the app, so it exercises authenticated connections, room joins, message writes, acknowledgements, and room broadcasts without a Node.js load-test runner. Each virtual user runs once, spreads its login across the configured ramp-up, stays connected for the hold duration, waits briefly for outstanding message acknowledgements, then sends a Socket.IO disconnect and closes its WebSocket.

## Prerequisites

- Docker Compose PostgreSQL and Redis are healthy.
- Migrations 001–004 have been applied.
- The API is running at `http://localhost:3000`.
- Seeded demo accounts exist, and the target room is available. The default room is `seed-channel-001`.
- Grafana k6 is installed. On macOS, install it with Homebrew:

```bash
brew install k6
```

## Seed local accounts

After clearing or setting up a local database, seed at least as many accounts as the virtual-user count. Run this from `apps/api`:

```bash
SEED_USER_COUNT=50 npm run seed:local
```

The local seeder is additive and does not delete or overwrite existing rows. Its default demo password is `DMChat-Seed-Only-2026!`, unless `SEED_PASSWORD` was set during seeding.

## Run the baseline

Run these commands from the project root. Start with a small number of users and increase gradually:

```bash
cd ~/Desktop/systems/scalable-chat-system
VUS=10 SEED_USER_COUNT=50 k6 run load-tests/scenarios/socketio-baseline.js
```

For 40 or 50 users:

```bash
VUS=40 SEED_USER_COUNT=50 k6 run load-tests/scenarios/socketio-baseline.js
VUS=50 SEED_USER_COUNT=50 k6 run load-tests/scenarios/socketio-baseline.js
```

The defaults are a 10-second ramp-up, a 30-second hold, and one message per user per second. Configure a different base URL, duration, ramp-up, pace, room, or password with environment variables:

```bash
API_URL=http://localhost:3000 \
VUS=10 \
SEED_USER_COUNT=50 \
DURATION_SECONDS=30 \
RAMP_UP_SECONDS=10 \
MESSAGE_INTERVAL_MS=1000 \
ROOM_ID=seed-channel-001 \
LOADTEST_PASSWORD='DMChat-Seed-Only-2026!' \
k6 run load-tests/scenarios/socketio-baseline.js
```

The script uses `demo001@example.com`, `demo002@example.com`, and so on, assigning one account per virtual user. `SEED_USER_COUNT` is a safety check in the script; it does not create accounts. The test prints k6's metrics summary and fails its thresholds when success rates fall below 99%, login HTTP p95 reaches 2 seconds, or message acknowledgement p95 reaches 250 milliseconds. These are initial local guardrails based on the repeated 100-VU baseline; adjust them when your target service levels are defined. A rare maximum-latency spike can still occur while p95 passes, so review both p95 and max values. Messages are written to the database and remain there after the run; use a local development database and a dedicated seeded room.

For a private group test, select `ROOM_ID=seed-group-001` and keep `VUS` at or below the group's membership count. The `general` channel is available but may contain development messages.

This is a modest single-instance baseline. Larger load-test scenarios and result tracking remain future work; Prometheus/Grafana dashboards and Redis Socket.IO multi-instance testing also remain future work.
