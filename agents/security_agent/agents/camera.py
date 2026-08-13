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

from ..base import AgentConfigurationError, BaseAgent
from ..contracts import AgentType, EventType, SensorEvent, iso_now
from ..evidence import ClipUploader, EvidenceRecorder
from ..transport import Transport

log = logging.getLogger(__name__)

#: Frames discarded while MOG2 learns the background. Without this the first frame
#: is entirely "foreground" and every camera reports motion the instant it starts.
WARMUP_FRAMES = 30

#: Consecutive failed frame reads before trying to reopen the stream. RTSP blips are
#: routine, so a handful of misses is not worth reconnecting over.
MAX_READ_FAILURES = 25

#: Reopen attempts before giving up. A camera that cannot deliver frames is blind,
#: and a blind camera that keeps heartbeating is worse than one that stops: the hub
#: would report it healthy forever. Exiting lets agent_offline tell the truth.
MAX_REOPEN_ATTEMPTS = 3


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
        recorder: EvidenceRecorder | None = None,
        uploader: ClipUploader | None = None,
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
        self._read_failures = 0
        self._reopen_attempts = 0
        self._recorder = recorder
        self._uploader = uploader
        #: Lower bound on when a clip can exist: the post-roll must finish recording
        #: first. Published so a consumer knows how long to wait before retrying.
        self._post_roll_ms = recorder.post_roll_ms if recorder is not None else 0
        if recorder is not None:
            self.capabilities = [*self.capabilities, "evidence"]

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

        detection = {**detection, **self._start_evidence_clip()}
        return [self.make_event(EventType.CAMERA_MOTION, **detection)]

    def _start_evidence_clip(self) -> dict[str, Any]:
        """Kicks off clip capture and returns the metadata referencing it.

        The reference is returned immediately rather than after the upload completes:
        the event matters more than the clip, and blocking ingestion on encode plus an
        object-store round trip would delay the alert by seconds — precisely while
        something is happening.

        The consequence is that the clip is referenced slightly **before it exists**
        (observed lag: ~300-400ms for a 2s clip, bounded below by post-roll duration).
        A consumer fetching `clip_url` should therefore treat a 404 as "not yet" and
        retry, not as "lost". No `clip_status` field is published, because a status
        written at detection time could never be updated afterwards and would sit at
        "pending" forever — a permanently wrong field is worse than none.

        Making this exact would need the agent to confirm the upload against the
        created event, which means threading the hub's event id back into the upload
        worker. Worth doing if a dashboard needs to distinguish "still uploading" from
        "genuinely missing"; the retry rule is sufficient until then.
        """
        if self._recorder is None:
            return {}

        # Sortable, collision-free, and grouped per agent so a bucket lifecycle rule
        # can expire evidence per camera.
        stamp = iso_now().replace(":", "-").replace(".", "-")
        object_key = f"{self.agent_id}/{stamp}.mp4"
        self._recorder.begin_clip(object_key)

        metadata: dict[str, Any] = {
            "clip_key": object_key,
            # How long a consumer should expect to wait before the object exists.
            "clip_available_after_ms": int(self._post_roll_ms),
        }
        if self._uploader is not None:
            metadata["clip_url"] = self._uploader.url_for(object_key)
        return metadata

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
            raise AgentConfigurationError(
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
            raise AgentConfigurationError(
                f"Could not open camera source {source!r}. For a webcam try --source 0; "
                "for an IP camera pass the full rtsp:// URL. On Windows, note that a "
                "webcam already in use by another application cannot be opened here."
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
            # A dropped frame is routine on RTSP, so absorb a run of them — but not
            # indefinitely, or a camera whose stream died stays "online" and blind.
            self._read_failures += 1
            log.debug("Frame read failed (%s consecutive)", self._read_failures)
            if self._read_failures >= MAX_READ_FAILURES:
                self._reopen()
            return None

        self._read_failures = 0
        self._reopen_attempts = 0
        self._frame_index += 1

        # Every frame feeds the rolling buffer, so a clip triggered later already has
        # its pre-roll in hand — motion is only detected once a subject is well into
        # frame, and a clip starting at the trigger would miss the entry.
        if self._recorder is not None:
            self._recorder.observe(frame)

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
            # Clip references are added by _start_evidence_clip (roadmap item 5) —
            # metadata is free-form precisely so that needed no migration.
        }

    def _reopen(self) -> None:
        """Tears the stream down and reopens it, giving up after a few attempts.

        Raises AgentConfigurationError once out of attempts, which the poll loop
        deliberately does not swallow — a camera that cannot produce frames should
        stop and let the hub raise agent_offline, rather than sit there reporting
        healthy heartbeats while seeing nothing.
        """
        self._reopen_attempts += 1
        log.warning(
            "No frames from %r after %s reads — reopening (attempt %s/%s)",
            self._source,
            self._read_failures,
            self._reopen_attempts,
            MAX_REOPEN_ATTEMPTS,
        )

        if self._reopen_attempts > MAX_REOPEN_ATTEMPTS:
            raise AgentConfigurationError(
                f"Camera source {self._source!r} stopped delivering frames and could not "
                f"be reopened after {MAX_REOPEN_ATTEMPTS} attempts. The hub will raise "
                "agent_offline for this agent, which is the honest signal — a camera that "
                "cannot see should not report as healthy."
            )

        if self._capture is not None:
            self._capture.release()

        # Force a full re-open through _ensure_cv2, including a fresh background
        # model: the scene may have changed while the stream was down, and reusing
        # the old model would flag the whole frame as motion.
        self._capture = None
        self._subtractor = None
        self._cv2 = None
        self._frame_index = 0
        self._read_failures = 0

    def on_shutdown(self) -> None:
        # Recorder first: it flushes a clip still collecting post-roll, so shutting
        # down mid-incident does not discard that incident's evidence.
        if self._recorder is not None:
            self._recorder.close()
        if self._capture is not None:
            self._capture.release()
