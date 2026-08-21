"""Copy to `config.py` on the board and edit. `config.py` is gitignored.

The bootstrap key lives here, on the device, which is the same trust model the Python
agents use: a sensor host holds the enrolment secret, uses it once, and thereafter
authenticates with its own issued token. Anyone with physical access to the board can read
it — which is true of the Pi as well, and is why the hub counts token rotations rather
than pretending the secret is safe.
"""

# --- network ---------------------------------------------------------------
# 2.4 GHz only. No ESP32 has a 5 GHz radio, and WPA2-Enterprise (eduroam and similar) is
# not supported here — use a phone hotspot set to 2.4 GHz for a demo.
WIFI_SSID = "your-network"
WIFI_PASSWORD = "your-password"

# The hub, reachable from the board. NOT localhost — that is the board itself. Use the
# host machine's LAN address, and prefer the Caddy port over the hub's direct port.
HUB_URL = "http://192.168.1.100:8080/api"

# Enrolment secret, used once and then replaced by the issued token.
BOOTSTRAP_KEY = "dev-bootstrap-key-change-me"

# --- identity --------------------------------------------------------------
# Stable across reboots: the hub keys history on this, so changing it orphans everything
# the device has reported before.
AGENT_ID = "esp32-front-door"
LOCATION = "Front Door"

# --- pins (BCM/GPIO numbers on the ESP32-S3) -------------------------------
# Avoid the strapping pins (0, 3, 45, 46) and the native USB pins (19, 20).
# Set either to None to disable that sensor.
PIR_PIN = 4
REED_PIN = 5

# True if the reed switch is normally-closed rather than normally-open. Which one you
# bought is not knowable from software, so this is the escape hatch — if the door reports
# backwards, flip this.
REED_INVERTED = False

# --- behaviour -------------------------------------------------------------
HEARTBEAT_SECONDS = 10
MOTION_COOLDOWN_MS = 10_000

# An HC-SR501 fires spuriously for roughly half a minute after power-up. Events are held
# back until this has passed, so a reboot does not report an intruder.
PIR_WARMUP_SECONDS = 30

# --- camera (optional) -----------------------------------------------------
# Only meaningful on a camera-equipped board (XIAO ESP32S3 Sense, Freenove S3 CAM) running
# a camera-enabled MicroPython build. Left False, the node is a sensors-only agent.
CAMERA_ENABLED = False
CAMERA_AGENT_ID = "esp32-cam-front"
CAMERA_LOCATION = "Front Door"
CAMERA_FPS = 5
# JPEG quantiser: LOWER is better quality, 10-15 typical. Inverted relative to every other
# quality setting here — that is the esp32-camera driver's convention, not a choice.
CAMERA_QUALITY = 12
