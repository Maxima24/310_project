"""Camera collector: MOG2 background subtraction over a webcam or RTSP stream.

``cv2`` is imported lazily inside :meth:`CameraAgent._ensure_cv2`, never at module
scope. That is a correctness requirement, not style: ``opencv-python-headless``
often has no prebuilt wheel for the newest CPython (3.14 at time of writing), and a
top-level import would break simulation mode — and the whole test suite — on a
machine that will never touch a camera.
"""

from __future__ import annotations

import logging
import random
import time
from typing import Any

from ..base import BaseAgent
from ..contracts import AgentType, EventType, SensorEvent
from ..transport import Transport

log = logging.getLogger(__name__)

#: Frames discarded while MOG2 learns the background. Without this the first frame
#: is entirely "foreground" and every camera reports motion the instant it starts.
WARMUP_FRAMES = 30


class CameraAgent(BaseAgent):
    """Reports ``camera_motion`` when a large enough moving region appears.

    Detection is deliberately cheap — MOG2 plus a contour-area threshold, no
    classifier. The goal is 'something sizeable moved', which is what a security
    trigger needs; distinguishing a person from a curtain is a different problem.
    """

    def __init__(
        self,
        agent_id: str,
        location: str,
        transport: Transport,
        *,
        real: bool = False,
        source: str | int = 0,
        min_area: float = 1500.0,
        cooldown: float = 10.0,
        poll_interval: float = 0.2,
        heartbeat_interval: float = 10.0,
        simulated_probability: float = 0.03,
        seed: int | None = None,
    ) -> None:
        super().__init__(
            agent_id,
            location,
            transport,
            poll_interval=poll_interval,
            heartbeat_interval=heartbeat_interval,
            capabilities=["camera", "mog2"] if real else ["camera", "simulated"],
        )
        self._real = real
        self._source = source
        self._min_area = min_area
        self._cooldown = cooldown
        self._last_emit = 0.0
        self._frame_index = 0
        self._random = random.Random(seed)
        self._simulated_probability = simulated_probability

        self._cv2: Any = None
        self._capture: Any = None
        self._subtractor: Any = None
        self._kernel: Any = None

    @property
    def agent_type(self) -> AgentType:
        return AgentType.CAMERA

    def poll(self) -> list[SensorEvent]:
        detection = self._detect_real() if self._real else self._detect_simulated()
        if detection is None:
            return []

        # One cooldown gate for both paths — a camera at 5 fps would otherwise
        # report a single person walking past as dozens of events.
        now = time.monotonic()
        if now - self._last_emit < self._cooldown:
            return []
        self._last_emit = now

        return [self.make_event(EventType.CAMERA_MOTION, **detection)]

    # -- simulated ---------------------------------------------------------

    def _detect_simulated(self) -> dict[str, Any] | None:
        self._frame_index += 1
        if self._random.random() >= self._simulated_probability:
            return None
        return {
            "source": "simulated",
            "frame": self._frame_index,
            # Plausible enough that a dashboard rendering contour_area works
            # identically against simulated and real agents.
            "contour_area": round(self._random.uniform(self._min_area, self._min_area * 6), 1),
        }

    # -- real (OpenCV) -----------------------------------------------------

    def _ensure_cv2(self) -> Any:
        """Imports cv2 and opens the stream on first use.

        Kept out of __init__ so constructing the agent — which the tests do — never
        requires OpenCV to be installed.
        """
        if self._cv2 is not None:
            return self._cv2

        try:
            import cv2  # noqa: PLC0415 - deliberately lazy; see module docstring
        except ImportError as exc:
            raise RuntimeError(
                "Camera mode with --real needs OpenCV: "
                "pip install -r requirements-hardware.txt\n"
                "No wheel for your Python? opencv-python-headless often lags the "
                "newest CPython — use the Docker agent image (Python 3.12) or a "
                "3.12/3.13 virtualenv. Simulation mode needs none of this."
            ) from exc

        self._cv2 = cv2
        # A bare digit means a local device index; anything else is a URL/path.
        source = int(self._source) if str(self._source).isdigit() else self._source
        self._capture = cv2.VideoCapture(source)
        if not self._capture.isOpened():
            raise RuntimeError(
                f"Could not open camera source {source!r}. For a webcam try --source 0; "
                "for an IP camera pass the full rtsp:// URL."
            )

        self._subtractor = cv2.createBackgroundSubtractorMOG2(
            history=500, varThreshold=16, detectShadows=True
        )
        self._kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        log.info("Camera opened on %r (min_area=%.0f px)", source, self._min_area)
        return cv2

    def _detect_real(self) -> dict[str, Any] | None:
        cv2 = self._ensure_cv2()

        ok, frame = self._capture.read()
        if not ok:
            # A dropped frame on an RTSP stream is routine; returning None keeps
            # the agent heartbeating rather than treating it as fatal.
            log.debug("Frame read failed")
            return None

        self._frame_index += 1
        mask = self._subtractor.apply(frame)

        if self._frame_index <= WARMUP_FRAMES:
            return None

        # Shadow pixels come back as 127; drop them so a moving shadow does not
        # count toward contour area.
        _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)
        # Opening removes salt-and-pepper speckle that would otherwise fragment
        # one real blob into many small ones, none of which clears min_area.
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self._kernel)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        largest = max((cv2.contourArea(c) for c in contours), default=0.0)

        if largest < self._min_area:
            return None

        return {
            "source": str(self._source),
            "frame": self._frame_index,
            "contour_area": round(float(largest), 1),
            # TODO(roadmap-5): write a short clip around this frame, upload it to
            # S3/MinIO, and add its URL here — metadata is free-form precisely so
            # this needs no migration.
        }

    def on_shutdown(self) -> None:
        if self._capture is not None:
            self._capture.release()
