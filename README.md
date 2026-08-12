# Multi-agent physical security system

Distributed Python collector agents (cameras, door sensors, motion sensors) reporting to a central
NestJS hub that tracks agent health, evaluates alert rules, and streams live updates to dashboards
over WebSocket.

The design separates **collection** from **decision-making**: agents own hardware I/O and know nothing
about alert policy, and the hub owns the agent registry, the rules, the arm state, and the live feed.
Two properties follow from that split:

1. **A silent sensor is a security event.** An agent that stops heartbeating is treated as possible
   tamper, not a harmless disconnect — the hub raises `agent_offline` within ~30s.
2. **Alert policy depends on arm mode.** Motion at 3pm while `disarmed` is noise; the same motion in
   `away` is an intrusion. Rules are evaluated centrally, so changing policy never means redeploying
   a sensor.

## Layout

```
hub/                 NestJS hub (agent registry, event ingestion, alert engine, WebSocket feed)
agents/              Python collector agents (motion, door, camera)
packages/contracts/  Wire types shared by the hub and any client — source of truth
packages/tsconfig/   Shared TypeScript base config
tools/ws-client.mjs  Socket.io observer for watching the live feed
```

A pnpm + Turborepo monorepo. `hub` and `packages/*` are workspaces; the Python agents live alongside
with their own `requirements.txt`.

---

## Quick start (Docker — everything at once)

Brings up Postgres, the hub, and three simulated agents. No hardware needed.

```bash
cp .env.example .env        # set a real AGENT_API_KEY
docker compose up --build
```

Then jump to [Verify it end to end](#verify-it-end-to-end).

## Quick start (native)

**1. Install and start the hub**

```bash
pnpm install                # at the REPO ROOT — this is a workspace, not per-package
cp hub/.env.example hub/.env
```

Postgres must be reachable at the `DATABASE_URL` in `hub/.env`. The easiest way is to run just the
database in Docker:

```bash
docker compose up -d postgres
```

Then create the schema and start the hub:

```bash
pnpm db:migrate             # creates tables
pnpm db:seed                # optional — inserts the initial SystemState row
pnpm dev                    # hub on http://localhost:3000
```

**2. Start one or more agents** (simulation mode works on any machine)

```powershell
# PowerShell
cd agents
pip install -r requirements.txt
$env:AGENT_API_KEY = "dev-key-change-me"   # must match the hub's

python run_agent.py --type motion --id motion-hallway --location "Hallway"
python run_agent.py --type door   --id door-front     --location "Front door"
```

```bash
# bash / zsh
cd agents
pip install -r requirements.txt
export AGENT_API_KEY=dev-key-change-me

python run_agent.py --type motion --id motion-hallway --location "Hallway"
python run_agent.py --type door   --id door-front     --location "Front door"
```

---

## Verify it end to end

`curl` in PowerShell 5.1 is an alias for `Invoke-WebRequest`, so use `curl.exe` or the
`Invoke-RestMethod` forms below.

```powershell
$H = @{ 'x-agent-key' = 'dev-key-change-me'; 'Content-Type' = 'application/json' }
$B = 'http://localhost:3000'

# Agents registered and online
Invoke-RestMethod "$B/agents" -Headers $H | Format-Table id, type, status, secondsSinceLastSeen

# Auth is enforced — expect 401
try { Invoke-RestMethod "$B/agents" } catch { $_.Exception.Response.StatusCode.value__ }

# Arm the system
Invoke-RestMethod "$B/system/mode" -Method Post -Headers $H -Body '{"mode":"away"}'

# Trip a sensor -> critical alert
Invoke-RestMethod "$B/events" -Method Post -Headers $H -Body (@{
  agentId  = 'motion-hallway'
  type     = 'motion_detected'
  occurredAt = (Get-Date).ToUniversalTime().ToString('o')
  metadata = @{ source = 'manual-test' }
} | ConvertTo-Json)

Invoke-RestMethod "$B/alerts" -Headers $H | Format-Table type, severity, acknowledged, message

# Acknowledge the newest alert
$id = (Invoke-RestMethod "$B/alerts" -Headers $H)[0].id
Invoke-RestMethod "$B/alerts/$id/ack" -Method Post -Headers $H

# Tamper detection: kill an agent, expect agent_offline within ~30s
docker compose stop agent-door        # or Ctrl-C a native agent
Start-Sleep -Seconds 40
Invoke-RestMethod "$B/alerts" -Headers $H | Where-Object type -eq 'agent_offline'

# Recovery auto-acknowledges that alert and posts agent_recovered
docker compose start agent-door
Start-Sleep -Seconds 15
Invoke-RestMethod "$B/agents" -Headers $H | Where-Object id -eq 'door-front'
```

**Watch the live feed** while doing the above — this is also the only way to exercise the WebSocket
auth path, which the HTTP guard does not cover:

```bash
node tools/ws-client.mjs --key dev-key-change-me
```

A wrong `--key` is disconnected at handshake and exits 1.

**Inspect the database:**

```bash
docker compose exec postgres psql -U postgres -d security \
  -c 'select type, severity, acknowledged from "Alert" order by "createdAt" desc limit 10;'
```

Or `pnpm db:studio` for a browser UI.

## Tests

```bash
pnpm test                   # 76 hub tests
cd agents && pytest         # 44 agent tests
```

Hub coverage: the full mode × event rule matrix, dedup/cooldown, the liveness sweep (including the
startup grace period and re-entrancy), registry recovery paths, event ingest ordering and pagination
clamping, and boot-time env validation. Agent coverage: wire-format shapes, door edge detection, camera
cooldown and reconnect give-up, transport buffering/retry/re-registration, and CLI guards.

The hub tests mock Prisma, so no database is needed. The agent tests assert against literal wire
strings — they are the drift detector between `packages/contracts` and `security_agent/contracts.py`.

---

## Alert rules

Evaluated centrally, as a function of arm mode. `home` suppresses interior motion (occupants are
expected to move) but still guards doors — that asymmetry is the whole reason `home` exists as a
separate mode from `disarmed`.

| Event | `disarmed` | `home` | `away` |
|---|---|---|---|
| `motion_detected` | — | — | `intrusion_motion` / **critical** |
| `door_opened` | — | `intrusion_door` / warning | `intrusion_door` / **critical** |
| `door_closed` | — | — | — |
| `camera_motion` | — | — | `camera_motion` / warning |
| `agent_offline` | `agent_offline` / warning | `agent_offline` / **critical** | `agent_offline` / **critical** |

`agent_offline` fires in **every** mode including `disarmed` — a silent sensor is possible tamper, and
only the severity tracks arm state.

**Two independent rate limits**, both needed:

- **Agent-side cooldown** keeps a chattering sensor from flooding the network with events.
- **Hub-side dedup** (`ALERT_COOLDOWN_MS`, default 60s, per `(alert type, agent)`) keeps a legitimately
  busy sensor from flooding a human with alerts. Acknowledged alerts never suppress — once a human has
  cleared one, the next trip is real news.

The event log therefore still shows sustained activity even when only one alert fired.

### Liveness timing

Agents heartbeat every `HEARTBEAT_INTERVAL_MS` (10s). An agent is declared offline after
`HEARTBEAT_TIMEOUT_MS` (30s — three missed beats) of silence, detected by a sweep on
`LIVENESS_SWEEP_CRON` (every 5s). Worst-case detection is therefore **35s**, typically ~32s; set
`HEARTBEAT_TIMEOUT_MS=25000` for a hard 30s ceiling. The hub refuses to start if the timeout is not
greater than the interval, which would sweep healthy agents offline between beats.

An event counts as proof of life too, so a sensor busy reporting motion is never swept offline — and
because activity funnels through one code path, an event from an agent marked offline clears its
`agent_offline` alert exactly as a heartbeat would.

**Startup grace period.** The sweep does nothing for the first `HEARTBEAT_TIMEOUT_MS` of hub uptime.
Every agent's `lastSeenAt` is stale right after a hub restart, because the hub wasn't running to
receive heartbeats — sweeping then would declare the whole healthy fleet tampered-with and clear it
again seconds later. Waiting one timeout costs no detection latency, since a live agent beats well
inside that window.

---

## Failure handling

Deliberate choices about what happens when things break, since "a security system that lies about its
own health" is the failure that matters most.

| Situation | Behavior | Why |
|---|---|---|
| Hub restarts while agents run | No alerts | Startup grace period (above) |
| Agent's clock is badly wrong | Event **stored**, warning logged | Never drop a real intrusion report over a bad NTP setup; ordering uses hub time |
| Hub unreachable when an agent reports | Event buffered locally (cap 500, oldest dropped), flushed in order on reconnect | A brief outage must not lose the event that mattered |
| Hub's database is wiped | Agent gets 404, re-registers, retries | Fleet self-heals with nobody restarting anything |
| Agent's heartbeat hits an unexpected error | Thread logs and keeps beating | A dead heartbeat thread would raise a tamper alert for a demonstrably live agent |
| Sensor read throws | Logged, polling continues, backs off after 5 straight failures | A flaky sensor is a maintenance issue, not a reason to stop reporting liveness |
| OpenCV missing / camera won't open | Agent exits with a fix-it message (code 3) | Retrying forever helps nobody and hides the problem |
| Camera stream dies mid-run | Reconnects, then exits after 3 failed attempts | A blind camera reporting healthy heartbeats is worse than one that stops — exiting lets `agent_offline` tell the truth |
| Liveness sweep overruns its interval | Next tick skipped | Prevents double-alerting on the same agent |
| One agent fails to alert during a sweep | Remaining agents still processed | They're already marked offline and would otherwise never be reported |
| Sweep hits a DB error | Logged, job survives, next tick retries | A transient blip must not silently disable tamper detection |

**Input limits.** Request bodies are capped at 64 kB (`metadata` is free-form, and video evidence is a
URL reference by design, not an inline payload). `?limit=` is clamped to `EVENTS_PAGE_MAX`. The hub
refuses to boot on an `AGENT_API_KEY` under 8 characters, a `HEARTBEAT_TIMEOUT_MS` not greater than the
interval, or the sample key with `NODE_ENV=production`.

---

## API summary

All HTTP requests require `x-agent-key`. `GET /health` is the sole exception (Docker's healthcheck
needs it) and returns 503 when Postgres is unreachable.

| Method | Path | Purpose |
|---|---|---|
| POST | `/agents/register` | Agent announces itself (idempotent — upserts) |
| POST | `/agents/:id/heartbeat` | Keep-alive (every 10s); 404 if unregistered |
| GET | `/agents` | List agents + status |
| POST | `/events` | Ingest a sensor event; returns the alert it raised, if any |
| GET | `/events` | Recent events (`?limit=&since=&agentId=&type=`) |
| GET | `/alerts` | Recent alerts (`?limit=&acknowledged=&type=&agentId=`) |
| POST | `/alerts/:id/ack` | Acknowledge an alert (idempotent) |
| GET/POST | `/system/mode` | Get/set `disarmed` \| `home` \| `away` |
| GET | `/health` | Liveness + DB reachability (public) |

WebSocket clients connect with `{ auth: { key } }` and receive `event`, `alert`, `mode`, and `agent`
messages. Channel names are exported from `@cpe310/contracts` so a client cannot typo them.

---

## Real hardware

### Camera

```bash
pip install -r requirements.txt -r requirements-hardware.txt
python run_agent.py --type camera --id camera-lobby --location "Lobby" --real --source 0
python run_agent.py --type camera --id camera-gate  --location "Gate"  --real --source rtsp://...
```

MOG2 background subtraction, shadow pixels thresholded out, morphological opening to stop one real
blob fragmenting into sub-threshold specks, then a contour-area threshold (`--min-area`, default 1500
px) and a cooldown (`--cooldown`, default 10s) so one person walking past is not dozens of events. The
first 30 frames are discarded while the background model warms up — without that, every camera reports
motion the instant it starts.

> **OpenCV wheel caveat.** `opencv-python-headless` usually lags the newest CPython by months, and this
> machine runs Python 3.14, so `pip` may attempt a source build needing CMake. `cv2` is imported
> **lazily**, so simulation mode and the test suite work regardless. For a real camera, either run the
> agent in Docker (`agents/Dockerfile` pins Python 3.12) or make a 3.12/3.13 virtualenv for it.

`--real --source 0` **cannot** work inside Docker Compose on Windows or macOS — Docker Desktop has no
USB/webcam passthrough. Run the camera agent natively against the containerized hub:

```powershell
$env:AGENT_API_KEY = "dev-key-change-me"
python run_agent.py --type camera --id camera-lobby --location "Lobby" --real --source 0 --hub http://localhost:3000
```

### Raspberry Pi sensors

```bash
pip install -r requirements-hardware.txt
```

Then replace the marked stubs in [security_agent/sensors.py](agents/security_agent/sensors.py) — search
for `HARDWARE STUB`, two commented lines per class:

```python
from gpiozero import MotionSensor      # GpioMotionSensor
self._device = MotionSensor(pin)
return bool(self._device.motion_detected)

from gpiozero import Button            # GpioDoorSensor
self._device = Button(pin, pull_up=True)
```

Run with `--real --pin <BCM pin>`. Nothing else changes: the agents talk to a `SensorReader` protocol,
so simulated and real readers are interchangeable.

---

## Production roadmap

1. ~~**Persistence**~~ — **done.** Postgres via Prisma; events, alerts, agents, and arm state all
   persist. Agent liveness is a `lastSeenAt` column rather than Redis, which is fine at one hub
   instance; Redis becomes worthwhile when running several.
2. **Per-agent credentials** — replace the shared key with per-agent tokens issued at registration, or
   mTLS on a private network. The single `agentApiKey` read in
   [api-key.guard.ts](hub/src/common/guards/api-key.guard.ts) and the matching handshake check in
   [realtime.gateway.ts](hub/src/realtime/realtime.gateway.ts) are the only places to change — both
   share one constant-time comparison in `common/security/compare-key.ts`.
3. **Notification fan-out** — the `notify()` TODO in
   [alerts.service.ts](hub/src/alerts/alerts.service.ts) is where Twilio (SMS), FCM (push), or
   nodemailer hook in. Dispatch on a queue, not inline: a slow provider must not delay event ingestion.
4. **MQTT option** — at 20+ agents or on flaky networks, swap HTTP for MQTT (Mosquitto +
   `paho-mqtt` on agents, `@nestjs/microservices` on the hub). `BaseAgent` only ever touches the
   `Transport` interface, so this replaces `MqttTransport` and one line of `run_agent.py` — a transport
   swap, not a rewrite.
5. **Video evidence** — have `CameraAgent` save a short clip on motion and upload it (S3/MinIO),
   referencing it in `metadata`. That field is free-form `Json` precisely so this needs no migration;
   the TODO marks the spot.
6. **Dashboard** — any frontend that speaks socket.io. Subscribe to `event` / `alert` / `mode` /
   `agent`; [tools/ws-client.mjs](tools/ws-client.mjs) is a 90-line reference consumer.

## Configuration

See [hub/.env.example](hub/.env.example) for every setting with defaults and rationale. Required:
`AGENT_API_KEY` and `DATABASE_URL`. The hub validates its environment at boot and **exits with a plain
message** on anything missing or contradictory, rather than starting and failing mysteriously later. It
also refuses to start in production with the sample key still in place.
