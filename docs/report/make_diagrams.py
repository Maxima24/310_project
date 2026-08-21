"""Generates the report's architecture and design figures as PNGs.

Drawn with OpenCV rather than matplotlib or graphviz because neither is installed and
neither is needed: every figure here is boxes, arrows and text on a grid. Keeping the
dependency list at numpy plus cv2 — both already required by the camera agent — means the
report can be rebuilt on any machine that can already run the project.

Each figure renders at 2x and is downsampled, which is the cheapest way to get readable
text out of OpenCV bitmap fonts once Word scales the image to column width.

    python docs/report/make_diagrams.py
"""

import os

import cv2
import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
S = 2  # supersample factor

# Dark ink on white. The dashboard's own dark palette would turn to mud in a printed
# report, and these figures have to survive a greyscale photocopier.
INK = (40, 30, 25)
MUTED = (120, 110, 100)
LINE = (190, 180, 170)
ACCENT = (200, 110, 40)  # BGR: the project's brand blue
WARN = (40, 140, 220)
CRIT = (60, 60, 210)
OK = (90, 150, 60)
FILL = (250, 247, 244)
FILL_2 = (238, 233, 228)

FONT = cv2.FONT_HERSHEY_DUPLEX
FONT_S = cv2.FONT_HERSHEY_SIMPLEX


def canvas(w, h):
    return np.full((h * S, w * S, 3), 255, dtype=np.uint8)


def text(img, s, x, y, scale, colour, center=False, font=FONT_S, thick=1):
    scale = scale * S
    thick = max(1, int(thick * S * 0.8))
    if center:
        (tw, _), _ = cv2.getTextSize(s, font, scale, thick)
        x = x - tw // 2
    cv2.putText(img, s, (int(x), int(y)), font, scale, colour, thick, cv2.LINE_AA)


def box(img, x, y, w, h, label, sub=None, fill=FILL, border=LINE, thick=1):
    bx, by, bw, bh = x * S, y * S, w * S, h * S
    cv2.rectangle(img, (bx, by), (bx + bw, by + bh), fill, -1)
    cv2.rectangle(img, (bx, by), (bx + bw, by + bh), border, max(1, thick * S))
    cy = y + h // 2
    if sub:
        text(img, label, (x + w // 2) * S, (cy - 4) * S, 0.46, INK, center=True, font=FONT)
        text(img, sub, (x + w // 2) * S, (cy + 12) * S, 0.36, MUTED, center=True)
    else:
        text(img, label, (x + w // 2) * S, (cy + 4) * S, 0.46, INK, center=True, font=FONT)


def arrow(img, x1, y1, x2, y2, colour=MUTED, label=None):
    p1 = (int(x1 * S), int(y1 * S))
    p2 = (int(x2 * S), int(y2 * S))
    cv2.arrowedLine(img, p1, p2, colour, max(1, int(1.4 * S)), cv2.LINE_AA, tipLength=0.03)
    if label:
        text(img, label, ((x1 + x2) / 2) * S, ((y1 + y2) / 2 - 7) * S, 0.34, MUTED, center=True)


def save(img, name):
    h, w = img.shape[:2]
    out = cv2.resize(img, (w // S, h // S), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(OUT, name), out, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    print("  %-34s %dx%d" % (name, w // S, h // S))


def fig_architecture():
    img = canvas(920, 470)
    text(img, "Collector agents", 130 * S, 32 * S, 0.44, MUTED, center=True)
    box(img, 30, 45, 200, 52, "Motion agent", "PIR / simulated")
    box(img, 30, 110, 200, 52, "Door agent", "reed switch / simulated")
    box(img, 30, 175, 200, 52, "Camera agent", "OpenCV MOG2")
    box(img, 30, 240, 200, 52, "ESP32-S3 node", "MicroPython firmware")
    box(img, 30, 305, 200, 52, "Browser camera", "getUserMedia", fill=FILL_2)

    # Drawn without a centred label: this box carries its own list of responsibilities,
    # and box()'s vertical centring would print the title straight through them.
    cv2.rectangle(img, (320 * S, 120 * S), (510 * S, 310 * S), FILL_2, -1)
    cv2.rectangle(img, (320 * S, 120 * S), (510 * S, 310 * S), ACCENT, 2 * S)
    text(img, "SECURITY HUB", 415 * S, 150 * S, 0.50, INK, center=True, font=FONT)
    for i, line in enumerate(["NestJS 10 + Prisma", "auth, RBAC and ABAC",
                              "alert rule engine", "liveness sweep",
                              "retention and audit"]):
        text(img, line, 415 * S, (180 + i * 24) * S, 0.36, MUTED, center=True)

    box(img, 600, 60, 180, 52, "PostgreSQL 16", "events, alerts, audit")
    box(img, 600, 130, 180, 52, "MinIO / S3", "video evidence")
    box(img, 600, 200, 180, 52, "Mosquitto", "MQTT ingest")
    box(img, 600, 270, 180, 52, "SMTP", "notifications")

    box(img, 320, 372, 190, 60, "Operator dashboard", "React + Vite", border=ACCENT)
    box(img, 600, 372, 180, 60, "Caddy", "single origin, TLS")

    for y in (71, 136, 201, 266, 331):
        arrow(img, 230, y, 318, max(150, min(y, 285)))
    text(img, "HTTPS  /  MQTT", 275 * S, 360 * S, 0.34, MUTED, center=True)

    arrow(img, 512, 175, 598, 90)
    arrow(img, 512, 200, 598, 158)
    arrow(img, 512, 235, 598, 226)
    arrow(img, 512, 260, 598, 294)
    arrow(img, 415, 312, 415, 370, ACCENT, "WebSocket + REST")
    arrow(img, 598, 402, 512, 402)
    save(img, "fig01_architecture.png")


def fig_event_flow():
    img = canvas(920, 250)
    steps = [
        (20, "Sensor", "reads a pin"),
        (170, "Agent", "builds an event"),
        (320, "Hub ingest", "validates, stores"),
        (470, "Alert rules", "judges severity"),
        (620, "WebSocket", "broadcasts"),
        (770, "Dashboard", "renders"),
    ]
    for x, title, sub in steps:
        box(img, x, 88, 130, 62, title, sub)
    for x in (150, 300, 450, 600, 750):
        arrow(img, x, 119, x + 20, 119)

    text(img, "An event is PERSISTED BEFORE IT IS JUDGED, so the record survives a rule",
         460 * S, 44 * S, 0.42, INK, center=True)
    text(img, "change or a hub restart part-way through a decision.",
         460 * S, 68 * S, 0.42, INK, center=True)
    text(img, "own token only", 85 * S, 178 * S, 0.34, MUTED, center=True)
    text(img, "cooldown + dedup", 535 * S, 178 * S, 0.34, MUTED, center=True)
    text(img, "zone filtered", 685 * S, 178 * S, 0.34, MUTED, center=True)
    save(img, "fig02_event_flow.png")


def fig_data_model():
    img = canvas(920, 520)
    entities = [
        (40, 40, "Agent", ["id (PK)", "type, location", "status, lastSeenAt",
                           "tokenHash, origin"], ACCENT),
        (360, 40, "Event", ["id (PK)", "agentId (FK)", "type, metadata",
                            "occurredAt, createdAt"], ACCENT),
        (680, 40, "Alert", ["id (PK)", "type, severity", "agentId, eventId (FK)",
                            "acknowledged"], ACCENT),
        (680, 195, "Notification", ["alertId (FK)", "channel, status",
                                    "attempts, nextAttemptAt"], LINE),
        (360, 195, "EventRollup", ["hour, agentId, type", "count",
                                   "unique(hour, agent, type)"], LINE),
        (40, 195, "ArmSchedule", ["mode, daysOfWeek", "startMinute, timezone",
                                  "lastFiredFor"], LINE),
        (40, 335, "AuditLog", ["action, outcome", "actor, actorLabel",
                               "reason, targetId"], LINE),
        (360, 335, "SystemState", ["id = 1 (singleton)", "mode", "updatedAt"], LINE),
    ]
    for x, y, name, fields, border in entities:
        h = 34 + len(fields) * 16
        # Header at the TOP with a rule under it, rather than box()'s vertical centring,
        # which would print the entity name through its own field list.
        fill = FILL_2 if border is ACCENT else FILL
        cv2.rectangle(img, (x * S, y * S), ((x + 190) * S, (y + h) * S), fill, -1)
        cv2.rectangle(img, (x * S, y * S), ((x + 190) * S, (y + h) * S), border, 1 * S)
        text(img, name, (x + 95) * S, (y + 20) * S, 0.46, INK, center=True, font=FONT)
        cv2.line(img, (x * S, (y + 28) * S), ((x + 190) * S, (y + 28) * S), border, 1 * S)
        for i, f in enumerate(fields):
            text(img, f, (x + 14) * S, (y + 46 + i * 16) * S, 0.32, MUTED)

    arrow(img, 232, 78, 358, 78, MUTED, "1 : N")
    arrow(img, 552, 78, 678, 78, MUTED, "1 : N")
    arrow(img, 775, 140, 775, 193, MUTED, "1 : N")
    arrow(img, 455, 140, 455, 193, MUTED, "counted into")

    text(img, "EventRollup carries no foreign key: a summary has to outlive both the raw",
         460 * S, 460 * S, 0.40, INK, center=True)
    text(img, "events it counted and the agent that produced them.",
         460 * S, 484 * S, 0.40, INK, center=True)
    save(img, "fig03_data_model.png")


def fig_permissions():
    img = canvas(920, 450)
    roles = ["bootstrap", "agent", "viewer", "operator", "admin"]
    perms = [
        ("agents:enroll", [1, 0, 0, 0, 0]),
        ("events:write", [0, 1, 0, 0, 0]),
        ("agents:heartbeat", [0, 1, 0, 0, 0]),
        ("cameras:publish", [0, 1, 0, 0, 0]),
        ("agents:read", [0, 0, 1, 1, 1]),
        ("events:read", [0, 0, 1, 1, 1]),
        ("alerts:read", [0, 0, 1, 1, 1]),
        ("system:mode:read", [0, 0, 1, 1, 1]),
        ("cameras:view", [0, 0, 1, 1, 1]),
        ("schedules:read", [0, 0, 1, 1, 1]),
        ("alerts:ack", [0, 0, 0, 1, 1]),
        ("system:arm", [0, 0, 0, 1, 1]),
        ("system:disarm", [0, 0, 0, 1, 1]),
        ("schedules:write", [0, 0, 0, 1, 1]),
        ("notifications:read", [0, 0, 0, 0, 1]),
        ("audit:read", [0, 0, 0, 0, 1]),
        ("cameras:provision", [0, 0, 0, 0, 1]),
    ]
    x0, y0, rw, rh = 260, 72, 124, 21
    for i, r in enumerate(roles):
        text(img, r, (x0 + i * rw + rw // 2) * S, (y0 - 14) * S, 0.40, INK, center=True)
    for j, (perm, marks) in enumerate(perms):
        y = y0 + j * rh
        if j % 2 == 0:
            cv2.rectangle(img, (30 * S, (y - 15) * S), (890 * S, (y + 5) * S), FILL, -1)
        text(img, perm, 40 * S, y * S, 0.37, INK)
        for i, m in enumerate(marks):
            cx = (x0 + i * rw + rw // 2) * S
            if m:
                cv2.circle(img, (cx, (y - 5) * S), 5 * S, OK, -1, cv2.LINE_AA)
            else:
                cv2.circle(img, (cx, (y - 5) * S), 4 * S, LINE, 1 * S, cv2.LINE_AA)
    text(img, "Routes are guarded on PERMISSIONS, never on roles, so changing what a role",
         460 * S, 428 * S, 0.40, INK, center=True)
    save(img, "fig04_permissions.png")


def fig_alert_rules():
    img = canvas(920, 400)
    box(img, 360, 26, 200, 44, "Event arrives", None, border=ACCENT)
    box(img, 360, 104, 200, 44, "Read arm mode", None)
    box(img, 90, 190, 210, 54, "disarmed", "no alert raised", fill=FILL_2)
    box(img, 355, 190, 210, 54, "home", "perimeter sensors only")
    box(img, 620, 190, 210, 54, "away", "every sensor armed")
    box(img, 355, 296, 210, 54, "Cooldown check", "same type and agent", border=WARN)

    arrow(img, 460, 70, 460, 102)
    arrow(img, 420, 148, 250, 188)
    arrow(img, 460, 148, 460, 188)
    arrow(img, 500, 148, 700, 188)
    arrow(img, 460, 244, 460, 294)
    text(img, "A duplicate is suppressed while a matching alert is still unacknowledged.",
         460 * S, 378 * S, 0.40, MUTED, center=True)
    save(img, "fig05_alert_rules.png")


def fig_retention():
    img = canvas(920, 330)
    text(img, "Raw events", 105 * S, 58 * S, 0.44, INK, center=True)
    for i in range(14):
        h = 22 + (i * 9) % 44
        cv2.rectangle(img, ((32 + i * 13) * S, (152 - h) * S), ((40 + i * 13) * S, 152 * S),
                      ACCENT, -1)
    box(img, 250, 96, 150, 56, "Hourly rollup", "count per bucket", border=ACCENT)
    text(img, "Counted history", 500 * S, 58 * S, 0.44, INK, center=True)
    for i in range(4):
        cv2.rectangle(img, ((440 + i * 32) * S, 112 * S), ((464 + i * 32) * S, 152 * S), OK, -1)
    box(img, 620, 96, 250, 56, "Raw rows pruned", "only after counting", border=CRIT)

    arrow(img, 218, 124, 248, 124)
    arrow(img, 402, 124, 436, 124)
    arrow(img, 572, 124, 618, 124)

    text(img, "A 137 : 1 row reduction, measured on real data: 9,727 events into 71 buckets.",
         460 * S, 216 * S, 0.42, INK, center=True)
    text(img, "An event is never deleted before its hour has been counted, and an",
         460 * S, 254 * S, 0.40, MUTED, center=True)
    text(img, "UNACKNOWLEDGED alert is never deleted at any age.",
         460 * S, 280 * S, 0.40, MUTED, center=True)
    save(img, "fig06_retention.png")


def fig_deployment():
    img = canvas(920, 400)
    cv2.rectangle(img, (30 * S, 40 * S), (890 * S, 296 * S), FILL, -1)
    cv2.rectangle(img, (30 * S, 40 * S), (890 * S, 296 * S), LINE, 1 * S)
    text(img, "Docker Compose network", 58 * S, 64 * S, 0.42, MUTED)

    box(img, 60, 88, 160, 58, "caddy", "8080 / 8443", border=ACCENT)
    box(img, 270, 88, 160, 58, "hub", "port 3000")
    box(img, 480, 88, 160, 58, "postgres", "port 5432")
    box(img, 690, 88, 160, 58, "minio", "S3 API")
    box(img, 270, 196, 160, 58, "mosquitto", "MQTT 1883")
    box(img, 480, 196, 160, 58, "mailpit", "SMTP 1025")
    box(img, 690, 196, 160, 58, "agents x 3", "motion door camera")

    arrow(img, 222, 117, 268, 117)
    arrow(img, 432, 117, 478, 117)
    arrow(img, 432, 130, 688, 200)
    arrow(img, 350, 194, 350, 148)
    arrow(img, 545, 194, 480, 148)

    text(img, "Browser", 140 * S, 348 * S, 0.44, INK, center=True)
    arrow(img, 140, 330, 140, 148, ACCENT)
    text(img, "One origin: the SPA, /api and /socket.io all served through Caddy, so no CORS.",
         540 * S, 348 * S, 0.40, MUTED, center=True)
    save(img, "fig07_deployment.png")


def fig_liveness():
    img = canvas(920, 300)
    box(img, 60, 108, 170, 58, "online", "heartbeat < 30s", border=OK)
    box(img, 375, 108, 170, 58, "silent", "beats stop", border=WARN)
    box(img, 690, 108, 170, 58, "offline", "alert raised", border=CRIT)

    arrow(img, 232, 128, 373, 128, MUTED, "30s of silence")
    arrow(img, 547, 128, 688, 128, MUTED, "sweep detects")
    arrow(img, 688, 158, 232, 158, OK, "heartbeat returns, agent_recovered")

    text(img, "The HUB decides liveness, never the agent: a sensor that has been unplugged",
         460 * S, 236 * S, 0.42, INK, center=True)
    text(img, "does not get to send a going-offline message.",
         460 * S, 262 * S, 0.42, INK, center=True)
    save(img, "fig08_liveness.png")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    print("Rendering figures to %s" % OUT)
    fig_architecture()
    fig_event_flow()
    fig_data_model()
    fig_permissions()
    fig_alert_rules()
    fig_retention()
    fig_deployment()
    fig_liveness()
    print("done")
