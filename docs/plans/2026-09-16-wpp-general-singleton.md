# WhatsApp General Singleton Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make WhatsApp General safe across Render rolling deploys while keeping it enabled, persistent, fail-closed, and free of real-message smoke tests.

**Architecture:** A PostgreSQL session advisory lock elects one owner. A fenced singleton control row publishes owner/epoch/state/heartbeat and carries reset requests. One serialized supervisor owns every client generation and all initialize/restart/reset/shutdown transitions. Chromium's native profile lock remains a second barrier and is never automatically removed in Render.

**Tech Stack:** Node.js 22, PostgreSQL (`pg`), whatsapp-web.js, Node test runner, Render persistent disk.

---

## Non-negotiable invariants

1. Only the current owner may create/use a General WhatsApp client.
2. Every ownership update is fenced by `owner_id + epoch`; zero affected rows fails closed.
3. `initialize`, `restart`, `reset`, lease-loss, and shutdown are processed by one serial queue.
4. A new `Client` is created per generation; stale generation events are ignored.
5. Render never automatically removes `SingletonLock`, `SingletonSocket`, or `SingletonCookie`.
6. Explicit reset is persisted first; only the owner applies it while holding ownership.
7. Session deletion occurs only after Chromium termination is confirmed.
8. Outbox and replies are blocked immediately when ownership/heartbeat is invalid.
9. No verification sends a real WhatsApp message.

## Task 1: Persisted control repository and ownership primitive

**Files:**
- Create: `src/wpp/generalControlRepository.js`
- Create: `src/wpp/generalOwnership.js`
- Modify: `src/initDb.sql`
- Test: `tests/wpp-general-control.test.js`
- Test: `tests/wpp-general-ownership.test.js`

**TDD steps:**
1. Write failing tests for schema idempotency, owner epoch increment, fenced heartbeat/update, reset sequence monotonicity, dedicated advisory-lock connection, loser release, heartbeat timeout, and lock release.
2. Run focused tests and confirm RED.
3. Implement parameterized repository methods and session-level advisory ownership with a dedicated client.
4. Run focused tests and confirm GREEN.
5. Run `git diff --check` and commit.

**Constraints:** Never log connection strings. Never treat a clock-expired row alone as permission to use the shared profile; the advisory lock is authoritative.

## Task 2: Serialized General supervisor and client generations

**Files:**
- Create: `src/wpp/generalSupervisor.js`
- Create: `src/wpp/generalClientFactory.js`
- Test: `tests/wpp-general-supervisor.test.js`

**TDD steps:**
1. Write RED tests for concurrent initialize, restart during initialize, reset during restart, shutdown during a hung initialize, destroy failure, generation-stale events, profile-lock errors, heartbeat loss, and client recreation.
2. Implement one serialized command queue/state machine.
3. Use deadlines: heartbeat 3s, initialize 90s, destroy 10s, shutdown 20s.
4. On lease loss: close send gate immediately, mark not-ready, attempt bounded shutdown, and trigger fatal process termination even when destroy fails/hangs.
5. Never auto-delete Chromium singleton entries.
6. Confirm GREEN and commit.

## Task 3: Cluster-safe status and reset routes

**Files:**
- Modify: `src/wpp/routes.js`
- Modify: `src/wpp/whatsappWeb.js`
- Test: `tests/wpp-general-routes.test.js`

**TDD steps:**
1. Write RED tests proving `/reset` only persists a global reset request and returns `202` with sequence; it must not call `destroy`, `rmSync`, or `initialize`.
2. Write RED tests for cooldown and two concurrent reset requests.
3. Write RED tests showing `/status` returns persisted cluster state plus local owner/standby role.
4. Wire routes to repository/supervisor snapshots and confirm GREEN.
5. Commit.

## Task 4: Integrate lifecycle and remove unsafe paths

**Files:**
- Modify: `src/wpp/whatsappWeb.js`
- Modify: `src/wpp/clientLifecycle.js`
- Modify: `src/wpp/sessionUtils.js`
- Test: `tests/wpp-general-integration.test.js`

**TDD steps:**
1. Write RED integration tests for two application instances: exactly one creates/initializes a client; follower stays standby.
2. Write RED test that `browser/profile in use` performs zero `rm/unlink` operations.
3. Route all auth failure/disconnected/error callbacks into supervisor commands.
4. Remove direct retry/restart/destroy paths and reuse of destroyed clients.
5. Confirm old-generation listeners cannot mark the current generation ready.
6. Run focused suite and commit.

## Task 5: Fence outbox and inbound replies

**Files:**
- Modify: `src/wpp/outboxProcessor.js`
- Modify: `src/wpp/delivery.js`
- Modify: `src/handlers.js`
- Modify: `src/wpp/incomingMedia.js`
- Test: `tests/wpp-general-fencing.test.js`

**TDD steps:**
1. Write RED tests: ownership lost before send means zero sends; stale epoch cannot finish claim; lease loss closes replies/media responses.
2. Introduce a supervisor `withActiveClient` gate that asserts ownership immediately before transport use.
3. Tag outbox claim ownership with owner+epoch and require exactly one affected row on completion.
4. Preserve unknown-delivery results without automatic resend.
5. Confirm GREEN and commit.

## Task 6: Process shutdown and timers

**Files:**
- Modify: `src/bootstrap/startServer.js`
- Modify: `src/wpp/whatsappWeb.js`
- Test: `tests/wpp-general-shutdown.test.js`

**TDD steps:**
1. Write RED tests for SIGTERM: stop HTTP admission, cancel timers, close send gate, destroy Chromium once, release ownership only after confirmed stop, exit successfully.
2. Write RED test for hung/failed destroy: fatal exit deadline still fires; ownership is not voluntarily released first.
3. Make signal handling single-owner in `startServer` and return a shutdown handle from WhatsApp registration.
4. Confirm GREEN and commit.

## Task 7: Full verification and production gate

1. Run Node 22.22.0 focused WPP tests.
2. Run complete `npm test`.
3. Run `npm audit --omit=dev` and record residual advisories separately.
4. Run disposable PostgreSQL integration tests using a temporary schema and rollback; do not touch production data.
5. Obtain independent spec and quality/security reviews.
6. Commit `[verified]` only after both pass.
7. Before production migration: create and validate a same-major PostgreSQL backup.
8. Deploy exact immutable SHA with Auto-Deploy disabled.
9. Verify schema migration, owner/epoch heartbeat, old-instance standby/termination, persistent session path, health, CORS, and WPP QR/ready logs. Do not send a message.
