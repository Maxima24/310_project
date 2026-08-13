# Multi-agent physical security system

Distributed Python collector agents (cameras, door sensors, motion sensors) reporting to a central
NestJS hub that tracks agent health, evaluates alert rules, streams live updates over WebSocket, and
fans notifications out to humans. A React dashboard renders it.

The design separates **collection** from **decision-making**: agents own hardware I/O and know nothing
about alert policy; the hub owns the registry, the rules, the arm state, and the live feed. Two
properties follow:

1. **A silent sensor is a security event.** An agent that stops heartbeating is treated as possible
   tamper, not a harmless disconnect — the hub raises `agent_offline` within ~30s.
2. **Alert policy depends on arm mode.** Motion at 3pm while `disarmed` is noise; the same motion in
   `away` is an intrusion. Rules are evaluated centrally, so changing policy never means redeploying a
   sensor.

## Layout

```
hub/                 NestJS hub — registry, ingestion, alert engine, auth, notifications, WebSocket
agents/              Python collector agents (motion, door, camera)
dashboard/           React + Vite operator dashboard
packages/contracts/  Wire types, permissions, and role map shared by all three — source of truth
packages/tsconfig/   Shared TypeScript base config
deploy/Caddyfile     Reverse proxy: serves the dashboard, proxies the hub, automatic HTTPS
render.yaml          Render blueprint: hub + dashboard + managed Postgres
tools/ws-client.mjs  Socket.io observer for watching the live feed from a terminal
```

A pnpm + Turborepo monorepo. `hub`, `dashboard`, and `packages/*` are workspaces; the Python agents
live alongside with their own `requirements.txt`.

---

## Quick start

```bash
cp .env.example .env        # set real secrets
docker compose up --build
```

That brings up Postgres, Mosquitto (MQTT), Mailpit (SMTP), MinIO (evidence storage), the hub, and three
simulated agents — one of which reports over MQTT rather than HTTP.

| Service | URL |
|---|---|
| Hub API + WebSocket | http://localhost:3000 |
| Mailpit inbox (alert emails) | http://localhost:8025 |
| MinIO console (video evidence) | http://localhost:9001 — `minioadmin` / `minioadmin` |
| Postgres | localhost:**5433** (not 5432 — see below) |

Then start the dashboard:

```bash
pnpm install                # at the REPO ROOT — this is a workspace
pnpm --filter dashboard dev # http://localhost:5173
```

Sign in with `OPERATOR_KEY` from your `.env`.

> Postgres is published on **5433**, not 5432, because a locally-installed Postgres usually already owns
> 5432 and pointing the hub at the wrong server surfaces as a confusing authentication failure.
> Containers reach it as `postgres:5432` internally either way.

### If the hub or an agent container fails to start

**Use `--build`.** Plain `docker compose up` reuses cached images, so after pulling changes you get old
code against a new database and config. The failures look unrelated to the cause:

| Symptom | Cause |
|---|---|
| `dependency failed to start: container ...hub-1 is unhealthy`, and the hub log says `AGENT_API_KEY is required` | Stale hub image from before the credential split. `AGENT_API_KEY` no longer exists |
| Hub log reports fewer migrations than `hub/prisma/migrations` contains | Same — stale image |
| An agent restart-loops with `unrecognized arguments: --transport` | Stale agent image from before the MQTT transport |

```bash
docker compose build            # rebuild BOTH images, not just the hub
docker compose up -d
```

Then check it is actually working rather than merely running — `Up` only means the process started:

```powershell
docker compose ps -a            # nothing should say "Restarting"
Invoke-RestMethod 'http://localhost:3000/agents' -Headers @{ 'Authorization' = 'Bearer dev-operator-key-change-me' } |
  Format-Table id, status, secondsSinceLastSeen   # all online, seen seconds ago
```

A fatal misconfiguration in an agent shows as `Restarting` rather than `Exited`, because
`restart: unless-stopped` keeps retrying something a restart cannot fix. `docker compose logs <service>`
is the fastest way to see the real error.

### Running natively instead

```bash
docker compose up -d postgres mosquitto mailpit minio
cp hub/.env.example hub/.env
pnpm db:migrate && pnpm db:seed
pnpm dev                    # hub on :3000
```

```powershell
# PowerShell — agents get the enrollment secret only
cd agents
pip install -r requirements.txt
$env:AGENT_BOOTSTRAP_KEY = "dev-bootstrap-key-change-me"

python run_agent.py --type motion --id motion-hallway --location "Hallway"
python run_agent.py --type door   --id door-front     --location "Front door" --transport mqtt
```

```bash
# bash / zsh
export AGENT_BOOTSTRAP_KEY=dev-bootstrap-key-change-me
```

---

## Toolchain

Pinned deliberately, because a mismatched build machine fails in ways that do not name
their cause:

| Pin | Where | Why |
|---|---|---|
| Node 22 | `.nvmrc`, `.node-version`, both Dockerfiles | Active LTS, and the version hosted pipelines support most reliably. Keeping Docker, CI, and local dev on one major avoids "works in the container, fails in the pipeline" |
| pnpm from `packageManager` | root `package.json` | The Dockerfiles run bare `corepack enable` with **no** version argument, so corepack reads the manifest. The version lives in exactly one place |
| `engines` + `engine-strict` | `package.json`, `.npmrc` | The lockfile is `lockfileVersion: 9.0`, which **pnpm 8 cannot read**. Failing at install with a clear message beats `ERR_PNPM_LOCKFILE_BREAKING_CHANGE` halfway through CI |
| `pnpm.onlyBuiltDependencies` | root `package.json` | pnpm 10 blocks dependency install scripts by default. Without the allowlist, `@prisma/engines` is skipped and the build dies later with a confusing error |

**The Prisma client is generated, not committed.** `hub/src` imports types from it, so
nothing compiles until it exists — which is why `build`, `test`, `lint`, and `dev` all
run `prisma generate` first. It needs no `DATABASE_URL` and is idempotent, so the cost
is about a second and a clean checkout builds on any machine. Verified against a fresh
clone on **pnpm 10** with no `.env`: 3/3 build tasks, 200/200 tests.

> Building on a machine with a different pnpm? Use `corepack enable` and let it read
> `packageManager`. Installing pnpm globally (`npm i -g pnpm`) bypasses the pin and is
> the usual cause of lockfile complaints.

---

## Deployment

### Behind Caddy (Docker)

An overlay that puts the dashboard and hub on **one origin** with automatic HTTPS. The
plain development workflow is untouched — this is opt-in.

```bash
# Local, plain HTTP on http://localhost:8080
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up --build

# A real domain, certificates provisioned automatically
SITE_ADDRESS=hub.example.com ACME_EMAIL=you@example.com \
  docker compose -f docker-compose.yml -f docker-compose.caddy.yml up --build -d
```

| Path | Goes to |
|---|---|
| `/` | The built dashboard (static files, served by Caddy) |
| `/api/*` | `hub:3000`, prefix stripped — `/api/agents` arrives as `/agents` |
| `/socket.io/*` | `hub:3000`, prefix **kept** — socket.io needs the path intact |

Single-origin is the better arrangement: no CORS, and the operator credential is never
sent cross-site. Config lives in [deploy/Caddyfile](deploy/Caddyfile).

> The base compose file still publishes the hub on `3000`, and compose **merges** port
> lists rather than replacing them, so the hub stays directly reachable even behind the
> proxy. Convenient locally, wrong in production — there, add a third overlay setting
> the hub's `ports: []` so Caddy is genuinely the only entrance.

### Render

[render.yaml](render.yaml) declares a Docker web service for the hub, a static site for
the dashboard, and managed Postgres. Point a Render Blueprint at the repo.

Credentials use `generateValue`, so Render mints random secrets per environment and
nothing sensitive lives in the repo — read them from the Render dashboard to configure
agents and to sign in. `NODE_ENV=production` means the hub refuses to start if a sample
key is pasted in.

**This is a split-origin deployment**, unlike Caddy: the dashboard and hub get different
hostnames, so CORS is real and the dashboard is built with absolute URLs baked in
(`VITE_API_BASE` / `VITE_WS_URL` — see [dashboard/src/lib/config.ts](dashboard/src/lib/config.ts)).
Vite substitutes these at **build** time, so repointing a built bundle means rebuilding.

Not on Render, and deliberately so:

- **MQTT** — no managed broker. The agents' default HTTP transport works unchanged over
  the public URL; for MQTT, use a hosted broker and set `MQTT_URL` on the hub.
- **Object storage** — no MinIO. Video evidence should use real S3: point the camera
  agent's `--s3-endpoint` at AWS.
- **Agents** — they read physical sensors, so they belong where the hardware is. Run
  them on-prem with `--hub https://<your-hub>.onrender.com`.

---

## Roles and permissions

Credentials are split by role and all travel as `Authorization: Bearer <credential>`. **Every rule below
is enforced by the hub**, not merely reflected in the UI — the dashboard hides what the API would refuse,
but refusing is the API's job.

| Credential | Role | May |
|---|---|---|
| `AGENT_BOOTSTRAP_KEY` | `bootstrap` | Enroll an agent. **Nothing else.** |
| *(issued at enrollment)* | `agent` | Heartbeat and report events **as itself only** |
| `VIEWER_KEY` | `viewer` | Read agents, events, alerts, arm state |
| `OPERATOR_KEY` | `operator` | Viewer + acknowledge alerts + arm/disarm |
| `ADMIN_KEY` | `admin` | Operator + notification audit + policy overrides |

`VIEWER_KEY` and `ADMIN_KEY` are optional — leave one unset and that role does not exist. All configured
credentials must be **distinct**; a duplicate silently collapses two roles into one, so the hub refuses
to start.

Routes are guarded on **permissions**, not roles, so changing what a role may do never means editing a
controller. The mapping lives once, in [packages/contracts/src/auth.ts](packages/contracts/src/auth.ts).
A route that declares no permissions is **denied to everyone** — forgetting the decorator fails closed.

`GET /auth/me` returns the caller's role, permissions, and zones. The dashboard renders from that rather
than a hardcoded table, so a policy change on the hub takes effect in the browser with no redeploy.

### Attribute-based rules (ABAC)

Roles answer *what may this kind of user do?* Policies answer *may they do it right now, to this thing?*
Two rules go beyond roles:

**Disarming during an active incident requires an admin.** An operator cannot disarm while a critical
alert is unacknowledged. The failure mode this prevents is real: an alarm is sounding and the fastest way
to make it stop is to disarm rather than investigate — which is exactly what an intruder at the panel
would do. Acknowledging first is the intended path, and it unlocks disarming. Arming is *never* blocked;
refusing to let someone increase protection during an incident would be the wrong default.

**Zone-scoped credentials.** `VIEWER_ZONES=Hallway,Lobby` limits a credential to those agent locations.
Filtering happens in the database queries **and** in the WebSocket fan-out (via socket.io rooms) — without
the latter, a zone-restricted viewer would be filtered out of `GET /events` yet still receive every event
in the building over the socket, making the REST filtering decorative. A zoned caller also cannot widen
its scope with `?agentId=`, and cannot acknowledge alerts from another zone.

Refusals carry a human-readable reason and the role that could perform the action, so the dashboard can
explain rather than show a bare 403.

---

## Dashboard

React + Vite, in the monorepo so it shares `@cpe310/contracts` with the hub — a renamed WebSocket channel
or permission is a compile error, not a silently dead panel.

- **TanStack Query owns all server state.** The WebSocket writes into the *same* cache the REST queries
  populate, so there is one copy of each entity and no panel can disagree with a refetch.
- **Zustand holds only client state** — the session credential and view preferences. No server data.
- **Authorization comes from `/auth/me`.** Controls are gated on the returned permissions; the mode
  buttons additionally evaluate the disarm policy up front so the padlock carries the reason.
- Acknowledgement is optimistic (it only dims a row, and rolls back on failure). **Arm changes are not** —
  briefly showing a security panel as disarmed when it is not would be a dangerous lie.
- The cache is cleared whenever the credential changes, so signing in as a viewer never shows the previous
  admin session's data.

---

## Verify it end to end

```powershell
$H = @{ 'Authorization' = 'Bearer dev-operator-key-change-me'; 'Content-Type' = 'application/json' }
$B = 'http://localhost:3000'

Invoke-RestMethod "$B/auth/me"  -Headers $H          # who am I, and what may I do?
Invoke-RestMethod "$B/agents"   -Headers $H | Format-Table id, type, status, secondsSinceLastSeen
Invoke-RestMethod "$B/system/mode" -Method Post -Headers $H -Body '{"mode":"away"}'
Invoke-RestMethod "$B/alerts"   -Headers $H | Format-Table type, severity, acknowledged, message

# Tamper detection: kill an agent, expect agent_offline within ~30s
docker compose stop agent-door
Start-Sleep -Seconds 40
Invoke-RestMethod "$B/alerts" -Headers $H | Where-Object type -eq 'agent_offline'
docker compose start agent-door        # recovery auto-acknowledges it
```

Watch the feed from a terminal while doing the above:

```bash
node tools/ws-client.mjs --key dev-operator-key-change-me
```

A credential without `alerts:read` is disconnected at handshake — the one auth path the REST guard does
not cover.

**Notifications:** a critical alert produces a real email in Mailpit at http://localhost:8025. Set
`ALERT_WEBHOOK_URL` to also POST the alert JSON anywhere. Delivery attempts are recorded, so
`GET /notifications` (admin) answers *was anyone actually told?*

**Video evidence:** run a camera with `--record-evidence` and clips land in MinIO, referenced from the
event's `metadata.clip_url`.

## Tests

```bash
pnpm test                   # 200 hub tests
cd agents && pytest         # 64 agent tests
pnpm --filter dashboard build   # dashboard typecheck + build
```

Hub coverage includes the full mode × event alert matrix, dedup/cooldown, the liveness sweep (startup
grace, re-entrancy, post-crash reconciliation), the role × permission matrix, the ABAC policies, token
minting, event ingest ordering, and boot-time env validation. Prisma is mocked, so no database is needed.

Agent coverage includes wire-format shapes (the drift detector against `packages/contracts`), door edge
detection, camera cooldown and stream-reconnect give-up, transport buffering/retry/re-enrollment, evidence
pre-roll and upload-failure handling, and CLI guards.

---

## Alert rules

| Event | `disarmed` | `home` | `away` |
|---|---|---|---|
| `motion_detected` | — | — | `intrusion_motion` / **critical** |
| `door_opened` | — | `intrusion_door` / warning | `intrusion_door` / **critical** |
| `door_closed` | — | — | — |
| `camera_motion` | — | — | `camera_motion` / warning |
| `agent_offline` | `agent_offline` / warning | `agent_offline` / **critical** | `agent_offline` / **critical** |

`home` suppresses interior motion (occupants are expected to move) but still guards doors — that
asymmetry is the whole reason `home` exists. `agent_offline` fires in **every** mode including
`disarmed`; only the severity escalates.

**Two independent rate limits**, both needed: an agent-side cooldown keeps a chattering sensor off the
network, and a hub-side per-`(type, agent)` dedup (`ALERT_COOLDOWN_MS`, default 60s) keeps a busy sensor
from flooding a human. Acknowledged alerts never suppress — once a human has cleared one, the next trip
is real news. The event log still shows sustained activity even when one alert fired.

### Liveness timing

Agents heartbeat every 10s; an agent is offline after 30s of silence, detected by a sweep every 5s —
worst case 35s. The sweep does nothing for the first 30s of hub uptime, because every `lastSeenAt` is
stale right after a restart and sweeping then would declare the whole healthy fleet tampered-with. An
event counts as proof of life too, and clears an `agent_offline` alert exactly as a heartbeat would.

---

## API summary

All routes require `Authorization: Bearer <credential>` except `GET /health`.

| Method | Path | Requires | Purpose |
|---|---|---|---|
| GET | `/auth/me` | any human role | Role, permissions, zones |
| POST | `/agents/register` | bootstrap | Enroll; returns the agent's token **once** |
| POST | `/agents/:id/heartbeat` | that agent | Keep-alive |
| GET | `/agents` | `agents:read` | List agents + status |
| POST | `/events` | that agent | Ingest a sensor event |
| GET | `/events` | `events:read` | Recent events (`?limit=&since=&agentId=&type=`) |
| GET | `/alerts` | `alerts:read` | Recent alerts (`?limit=&acknowledged=&type=&agentId=`) |
| POST | `/alerts/:id/ack` | `alerts:ack` | Acknowledge (zone-checked) |
| GET | `/system/mode` | `system:mode:read` | Current arm state |
| POST | `/system/mode` | `system:arm` | Set `disarmed` \| `home` \| `away` (policy-checked) |
| GET | `/notifications` | `notifications:read` | Delivery audit (admin) |
| GET | `/health` | public | Liveness + DB reachability |

WebSocket clients connect with `{ auth: { key } }` and receive `event`, `alert`, `mode`, and `agent`
messages, zone-filtered. MQTT agents publish to `cpe310/agents/<id>/events` and `.../heartbeat` with
their token in the payload.

---

## Real hardware

### Camera

```bash
pip install -r requirements.txt -r requirements-hardware.txt
python run_agent.py --type camera --id camera-lobby --location "Lobby" --real --source 0
python run_agent.py --type camera --id camera-gate  --location "Gate"  --real --source rtsp://...
```

MOG2 background subtraction, shadow pixels thresholded out, morphological opening so one real blob does
not fragment into sub-threshold specks, then a contour-area threshold (`--min-area`, default 1500 px) and
a cooldown (`--cooldown`, default 10s). The first 30 frames are discarded while the background model warms
up — without that, every camera reports motion the instant it starts. A stream that dies is reconnected,
then the agent exits: a blind camera that keeps heartbeating is worse than one that stops.

Verified on Python 3.14 with `opencv-python-headless` 5.0.0 (wheel available, no source build) against a
webcam, a local file, and a live RTSP stream. `cv2` is imported lazily, so simulation mode and the tests
never need it.

`--real --source 0` **cannot** work inside Docker Compose on Windows or macOS — Docker Desktop has no
webcam passthrough. Run the camera agent natively against the containerized hub.

**Video evidence** (`--record-evidence`) records a clip around each detection and uploads it to
S3/MinIO. The clip starts *before* the detection: MOG2 only fires once a subject is well into frame, so a
clip beginning at the trigger misses the entry. Encoding and upload run off the poll loop, so the clip is
referenced a beat before it exists — `metadata.clip_available_after_ms` says how long to wait before
treating a 404 as missing.

### Raspberry Pi sensors

```bash
pip install -r requirements-hardware.txt
```

Then replace the marked stubs in [agents/security_agent/sensors.py](agents/security_agent/sensors.py) —
search for `HARDWARE STUB`, two commented lines per class:

```python
from gpiozero import MotionSensor      # GpioMotionSensor
self._device = MotionSensor(pin)
return bool(self._device.motion_detected)

from gpiozero import Button            # GpioDoorSensor
self._device = Button(pin, pull_up=True)
```

Run with `--real --pin <BCM pin>`. Nothing else changes: the agents talk to a `SensorReader` protocol, so
simulated and real readers are interchangeable.

---

## Failure handling

Deliberate choices about what happens when things break, because "a security system that lies about its
own health" is the failure that matters most.

| Situation | Behavior | Why |
|---|---|---|
| Hub restarts while agents run | No alerts | Startup grace period |
| Hub killed mid-sweep | Missing alerts raised on next boot | The sweep only looks at `online` agents, so a half-swept agent would sit silently offline forever |
| Agent's clock is badly wrong | Event **stored**, warning logged | Never drop a real intrusion report over bad NTP; ordering uses hub time |
| Hub unreachable when an agent reports | Buffered locally (cap 500), flushed in order | A brief outage must not lose the event that mattered |
| Hub's database wiped | Agent gets 404/401, re-enrolls, retries | Fleet self-heals with nobody restarting anything |
| Agent's heartbeat hits an unexpected error | Thread logs and keeps beating | A dead heartbeat thread would raise a tamper alert for a demonstrably live agent |
| Sensor read throws | Logged, polling continues, backs off after 5 straight failures | A flaky sensor is a maintenance issue, not a reason to stop reporting liveness |
| OpenCV missing / camera won't open | Agent exits with a fix-it message (code 3) | Retrying forever hides the problem |
| Camera stream dies mid-run | Reconnects, then exits after 3 attempts | A blind camera reporting healthy heartbeats is worse than one that stops |
| Notification channel fails | Retried with backoff from the database, capped at 5 attempts | In-memory retries would vanish on redeploy |
| Notification channel unconfigured | Inert | An unset `SMTP_HOST` means "no email", not a failed delivery per alert |
| Clip upload fails | Local copy **kept** | Deleting it would destroy the only remaining record |
| MQTT payload without a valid token | Rejected | MQTT does not propagate the publisher's identity, so the topic alone is not evidence |

**Input limits.** Bodies are capped at 64 kB; `?limit=` is clamped to `EVENTS_PAGE_MAX`. The hub refuses
to boot on a credential under 8 characters, duplicate credentials, a heartbeat timeout not greater than
the interval, or a sample key with `NODE_ENV=production`.

---

## Production roadmap

1. ~~**Persistence**~~ — **done.** Postgres via Prisma. Agent liveness is a `lastSeenAt` column rather
   than Redis, which is fine at one hub instance.
2. ~~**Per-agent credentials**~~ — **done.** Bootstrap-issued per-agent tokens (SHA-256 hashed at rest),
   plus viewer/operator/admin roles with RBAC and ABAC. mTLS remains the next step up; the bootstrap key
   is still a shared provisioning secret, so re-enrollments are counted and logged.
3. ~~**Notification fan-out**~~ — **done.** Email (SMTP) and webhook behind an `AlertChannel` interface,
   with persisted delivery records and database-backed retries. Twilio and FCM are a new file each plus
   one line in the provider array.
4. ~~**MQTT option**~~ — **done.** `--transport mqtt`; the hub ingests from MQTT and REST simultaneously
   through the same services, so rules cannot drift between transports.
5. ~~**Video evidence**~~ — **done.** Clips with pre-roll uploaded to S3/MinIO, referenced in `metadata`.
6. ~~**Dashboard**~~ — **done.** React + Vite with TanStack Query, Zustand, and permission-driven UI.

**Remaining, in rough priority order:** mTLS or short-lived enrollment tokens to replace the shared
bootstrap secret; a users table so zones and roles are per-user rather than per-key; Redis for liveness
once more than one hub instance runs; and an agent-confirmed upload so `clip_url` is never referenced
before it exists.

## Configuration

See [hub/.env.example](hub/.env.example) for every setting with its default and rationale. Required:
`AGENT_BOOTSTRAP_KEY`, `OPERATOR_KEY`, `DATABASE_URL`. The hub validates its environment at boot and
exits with a plain message on anything missing or contradictory, rather than starting and failing
mysteriously later.
