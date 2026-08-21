"""Every MicroPython-only import in the firmware lives here.

Deliberately the ONLY module that touches `machine`, `network`, `ntptime`, `urequests`, or
`camera`. Everything else — the contract, the sensor state machines, the hub client — is
plain Python that the pytest suite imports directly on a development machine. Without that
split, the only way to test a debounce window or a retry ladder would be to flash a board
and watch a serial log.

None of this file is exercised by the test suite, so keep it thin: it should contain
plumbing and no decisions.
"""

import machine
import network
import time


def connect_wifi(ssid, password, timeout_s=20, logger=print):
    """Joins a network and returns the interface, or None on timeout.

    Note 2.4 GHz only — no ESP32 has a 5 GHz radio. A phone hotspot defaulting to 5 GHz is
    the most common reason a board that works at a desk will not associate in a demo room.
    """
    station = network.WLAN(network.STA_IF)
    station.active(True)

    if not station.isconnected():
        logger("wifi: connecting to %s" % ssid)
        station.connect(ssid, password)

        deadline = time.time() + timeout_s
        while not station.isconnected() and time.time() < deadline:
            time.sleep(0.5)

    if not station.isconnected():
        logger("wifi: FAILED (2.4GHz only — check the band, and WPA2-Personal not Enterprise)")
        return None

    logger("wifi: %s" % station.ifconfig()[0])
    return station


def sync_clock(logger=print, attempts=3):
    """NTP-syncs the RTC. Returns True on success.

    NOT optional. `occurredAt` is validated as strict ISO 8601, and a board fresh from
    reset believes it is the year 2000, so every event would be refused with a message
    about the payload rather than the clock. Better to fail loudly here.
    """
    import ntptime

    for attempt in range(attempts):
        try:
            ntptime.settime()
            logger("clock: %s UTC" % str(time.gmtime()[:6]))
            return True
        except Exception as error:  # noqa: BLE001 - any failure means the same thing
            logger("clock: NTP attempt %d failed (%s)" % (attempt + 1, error))
            time.sleep(2)

    return False


def make_request_fn(timeout_s=10, logger=print):
    """Builds the `request_fn` HubClient expects, over urequests."""
    import ujson
    import urequests

    def request(method, url, headers, body):
        response = None
        try:
            if body is None:
                data = None
            elif isinstance(body, (bytes, bytearray)):
                data = body
            else:
                data = ujson.dumps(body)

            response = urequests.request(method, url, data=data, headers=headers)
            status = response.status_code

            parsed = None
            if status < 400:
                try:
                    parsed = response.json()
                except (ValueError, OSError):
                    parsed = None
            return status, parsed
        except Exception as error:  # noqa: BLE001 - a dead network raises many types
            logger("http: %s %s failed (%s)" % (method, url, error))
            return 0, None
        finally:
            # Mandatory on MicroPython: an unclosed response leaks its socket, and a few
            # dozen leaks exhaust the heap and wedge the board.
            if response is not None:
                response.close()

    return request


def digital_in(pin_number, pull_up=False):
    """A readable input pin. `pull_up` for a switch that shorts to ground."""
    pull = machine.Pin.PULL_UP if pull_up else None
    return machine.Pin(pin_number, machine.Pin.IN, pull)


def ticks_ms():
    return time.ticks_ms()


def iso_now():
    from contracts import iso_timestamp

    return iso_timestamp(time.gmtime())


def feed_watchdog(wdt):
    if wdt is not None:
        wdt.feed()


def make_watchdog(timeout_ms=60_000):
    """A hardware watchdog, so a wedged board reboots instead of going quiet.

    An unattended sensor that has hung looks exactly like one that is working and has seen
    nothing — which is the failure this whole system exists to catch. Rebooting turns a
    silent hang into a brief gap plus, if it persists, an agent_offline alert.
    """
    try:
        return machine.WDT(timeout=timeout_ms)
    except Exception:  # noqa: BLE001 - unsupported on some ports; not worth failing boot
        return None


# ------------------------------------------------------------------------- camera


def init_camera(frame_size=None, quality=12, logger=print):
    """Starts the OV2640 and returns the module, or None if unavailable.

    REQUIRES A CAMERA-ENABLED BUILD. Stock MicroPython for ESP32-S3 has no `camera`
    module, so this returns None on a standard firmware and the node runs as a
    sensors-only agent rather than failing to boot — a camera you did not flash support
    for should not take the door sensor down with it.

    `quality` is the JPEG quantiser, where LOWER is better and 10-15 is the usual range.
    It is inverted relative to every other quality setting in this project, which is a
    property of the underlying esp32-camera driver rather than a choice made here.
    """
    try:
        import camera
    except ImportError:
        logger("camera: not in this firmware build — running sensors only")
        return None

    try:
        camera.init(0, format=camera.JPEG)
        if frame_size is not None:
            camera.framesize(frame_size)
        camera.quality(quality)
        logger("camera: ready")
        return camera
    except Exception as error:  # noqa: BLE001
        logger("camera: init failed (%s)" % error)
        return None


def capture_jpeg(camera_module):
    """One JPEG, or None.

    The buffer is returned rather than held: a frame is tens of kilobytes against a few
    hundred available, so keeping two alive at once is how this runs out of memory.
    """
    if camera_module is None:
        return None
    try:
        return camera_module.capture()
    except Exception:  # noqa: BLE001
        return None
