import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const baseUrl = (__ENV.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const vus = Number(__ENV.VUS || 10);
const rampSeconds = Number(__ENV.RAMP_UP_SECONDS || 10);
const durationSeconds = Number(__ENV.DURATION_SECONDS || 30);
const intervalMs = Number(__ENV.MESSAGE_INTERVAL_MS || 1000);
const seedUserCount = Number(__ENV.SEED_USER_COUNT || 12);
const roomId = __ENV.ROOM_ID || 'seed-channel-001';
const password = __ENV.LOADTEST_PASSWORD || __ENV.SEED_PASSWORD || 'DMChat-Seed-Only-2026!';

const loginSuccess = new Rate('login_success');
const socketConnected = new Rate('socket_connected');
const roomJoinSuccess = new Rate('room_join_success');
const messageAckSuccess = new Rate('message_ack_success');
const messageAckFailures = new Counter('message_ack_failures');
const roomEvents = new Counter('room_message_events');
const messageAckLatency = new Trend('message_ack_latency', true);

if (!Number.isInteger(vus) || vus < 1) throw new Error('VUS must be a positive integer');
if (!Number.isInteger(seedUserCount) || seedUserCount < vus) {
  throw new Error('SEED_USER_COUNT must be at least VUS; seed enough demo accounts first');
}
if (!Number.isInteger(rampSeconds) || rampSeconds < 0) throw new Error('RAMP_UP_SECONDS must be 0 or more');
if (!Number.isInteger(durationSeconds) || durationSeconds < 1) throw new Error('DURATION_SECONDS must be at least 1');
if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('MESSAGE_INTERVAL_MS must be at least 1');

export const options = {
  scenarios: {
    socketio_baseline: {
      executor: 'per-vu-iterations',
      vus,
      iterations: 1,
      maxDuration: `${rampSeconds + durationSeconds + 60}s`,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    login_success: ['rate>0.99'],
    socket_connected: ['rate>0.99'],
    room_join_success: ['rate>0.99'],
    message_ack_success: ['rate>0.99'],
    // Initial local guardrails based on the repeated 100-VU baseline runs.
    http_req_duration: ['p(95)<2000'],
    message_ack_latency: ['p(95)<250'],
  },
};

function login(email) {
  const response = http.post(
    `${baseUrl}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'auth_login' } },
  );
  let accessToken = '';
  try {
    accessToken = response.json('accessToken') || '';
  } catch (_) {
    accessToken = '';
  }
  const ok = response.status === 201 && Boolean(accessToken);
  loginSuccess.add(ok);
  check(response, { 'login returned an access token': () => ok });
  return accessToken;
}

export default function () {
  // Stagger each VU's login and connection to create a steady ramp-up.
  const rampPosition = (__VU - 1) / Math.max(vus - 1, 1);
  sleep(rampPosition * rampSeconds);

  const email = `demo${String(__VU).padStart(3, '0')}@example.com`;
  const token = login(email);
  if (!token) return;

  const socketUrl = `${baseUrl.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  let joined = false;
  let namespaceReady = false;
  let joinOutcomeRecorded = false;
  let closing = false;
  let disconnectStarted = false;
  let closeDeadline = 0;
  let nextAckId = 1;
  const sentAt = new Map();

  const response = ws.connect(socketUrl, { tags: { name: 'socketio_websocket' } }, (socket) => {
    socket.on('open', () => {
      socketConnected.add(true);
      socket.setTimeout(() => {
        if (!joinOutcomeRecorded) {
          joinOutcomeRecorded = true;
          roomJoinSuccess.add(false);
          socket.close();
        }
      }, 15000);
    });
    socket.on('error', (error) => {
      const reason = error && typeof error.error === 'function' ? error.error() : '';
      if (reason !== 'websocket: close sent') socketConnected.add(false);
    });
    socket.on('message', (frame) => {
      if (frame === '2') {
        socket.send('3');
        return;
      }

      if (frame.startsWith('0')) {
        // Engine.IO open packet; authenticate the Socket.IO namespace with the JWT.
        socket.send(`40${JSON.stringify({ token })}`);
        return;
      }

      if (frame.startsWith('40')) {
        if (!namespaceReady) {
          namespaceReady = true;
          const ackId = nextAckId++;
          socket.send(`42${ackId}${JSON.stringify(['room:join', { roomId }])}`);
        }
        return;
      }
      if (frame.startsWith('44')) {
        socketConnected.add(false);
        socket.close();
        return;
      }

      if (frame.startsWith('43')) {
        const match = frame.match(/^43(\d+)(.*)$/);
        if (!match) return;
        const ackId = Number(match[1]);
        let result;
        try {
          result = JSON.parse(match[2])[0];
        } catch (_) {
          result = null;
        }

        if (ackId === 0) return;
        if (!joined) {
          const ok = result?.ok === true;
          joinOutcomeRecorded = true;
          roomJoinSuccess.add(ok);
          check({ ok }, { 'room join acknowledged': (result) => result.ok });
          if (!ok) {
            socket.close();
            return;
          }
          joined = true;
          socket.setTimeout(beginGracefulClose, durationSeconds * 1000);
          socket.setTimeout(sendMessage, intervalMs);
          return;
        }

        const startedAt = sentAt.get(ackId);
        sentAt.delete(ackId);
        const ok = result?.ok === true;
        messageAckSuccess.add(ok);
        if (ok && startedAt) messageAckLatency.add(Date.now() - startedAt);
        if (!ok) messageAckFailures.add(1);
        if (closing) {
          finishAfterPendingAcks();
        } else {
          socket.setTimeout(sendMessage, intervalMs);
        }
      }

      if (frame.startsWith('42')) {
        try {
          const packet = JSON.parse(frame.slice(2).replace(/^\d+/, ''));
          if (packet[0] === 'message:new') roomEvents.add(1);
        } catch (_) {
          // Ignore non-event Socket.IO frames.
        }
      }
    });

    function sendMessage() {
      if (!joined || closing) return;
      const ackId = nextAckId++;
      sentAt.set(ackId, Date.now());
      socket.send(`42${ackId}${JSON.stringify(['message:send', {
        roomId,
        content: `k6 baseline vu=${__VU} message=${ackId}`,
      }])}`);
    }

    function beginGracefulClose() {
      if (closing) return;
      closing = true;
      closeDeadline = Date.now() + 5000;
      finishAfterPendingAcks();
    }

    function finishAfterPendingAcks() {
      if (disconnectStarted) return;
      if (sentAt.size > 0 && Date.now() < closeDeadline) {
        socket.setTimeout(finishAfterPendingAcks, 50);
        return;
      }

      if (sentAt.size > 0) {
        for (const _ackId of sentAt.keys()) {
          messageAckSuccess.add(false);
          messageAckFailures.add(1);
        }
        sentAt.clear();
      }

      disconnectStarted = true;
      socket.send('41'); // Socket.IO namespace disconnect.
      socket.setTimeout(() => socket.close(), 100);
    }

    socket.on('close', () => {
      if (sentAt.size > 0) {
        for (const _ackId of sentAt.keys()) {
          messageAckSuccess.add(false);
          messageAckFailures.add(1);
        }
        sentAt.clear();
      }
      if (!joinOutcomeRecorded) {
        joinOutcomeRecorded = true;
        roomJoinSuccess.add(false);
      }
    });
  });

  const upgradeOk = response && response.status === 101;
  if (!upgradeOk) socketConnected.add(false);
  check(response, { 'Socket.IO WebSocket upgraded': () => upgradeOk });
}
