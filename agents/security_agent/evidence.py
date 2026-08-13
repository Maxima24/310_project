"""Video evidence capture and upload (roadmap item 5).

A `camera_motion` event says something moved; a clip says *what*. Without one, an
operator woken at 3am has to decide whether to call the police based on a contour
area in pixels.

Two design points that matter more than they look:

* **Pre-roll.** The clip starts *before* the detection, not at it. Motion is only
  detected once a subject is already well into frame, so a clip beginning at the
  trigger routinely misses the entry — which is the part you actually want. A rolling
  buffer of recent frames is kept at all times so the pre-roll is already in hand.

* **Upload off the poll loop.** Encoding and uploading take far longer than a frame
  interval. Doing them inline would stall detection for seconds — exactly while
  something is happening — so both run on a worker thread, and the event is sent
  immediately with the clip's eventual object key rather than waiting for the upload.
"""

from __future__ import annotations

import logging
import queue
import threading
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: Give up on a clip rather than let encode/upload work pile up unboundedly. A
#: camera tripping constantly must not exhaust memory or disk.
MAX_QUEUED_CLIPS = 4


@dataclass(frozen=True, slots=True)
class ClipSpec:
    """Everything needed to write one clip, captured at trigger time."""

    object_key: str
    frames: list[Any]
    fps: float
    width: int
    height: int


class EvidenceRecorder:
    """Maintains the pre-roll buffer and writes/uploads clips on a worker thread."""

    def __init__(
        self,
        agent_id: str,
        *,
        uploader: "ClipUploader | None",
        output_dir: Path,
        pre_roll_seconds: float = 2.0,
        post_roll_seconds: float = 3.0,
        fps: float = 15.0,
        keep_local: bool = False,
    ) -> None:
        self.agent_id = agent_id
        self._uploader = uploader
        self._output_dir = Path(output_dir)
        self._fps = fps
        self._pre_roll_frames = max(1, int(pre_roll_seconds * fps))
        self._post_roll_frames = max(1, int(post_roll_seconds * fps))
        self._keep_local = keep_local

        #: Rolling window of recent frames, so the pre-roll is always available.
        self._recent: deque[Any] = deque(maxlen=self._pre_roll_frames)
        #: Set while collecting post-roll frames for an in-progress clip.
        self._collecting: list[Any] | None = None
        self._pending_key: str | None = None

        #: Exposed so the camera can tell consumers how long to wait before the clip
        #: object can possibly exist — the post-roll has to be recorded first.
        self.post_roll_ms = int(post_roll_seconds * 1000)

        self._queue: queue.Queue[ClipSpec | None] = queue.Queue(maxsize=MAX_QUEUED_CLIPS)
        self._stop = threading.Event()
        self._worker = threading.Thread(
            target=self._drain, name=f"{agent_id}-evidence", daemon=True
        )
        self._worker.start()

    # -- frame intake ------------------------------------------------------

    def observe(self, frame: Any) -> None:
        """Called for every decoded frame, detection or not."""
        if self._collecting is not None:
            self._collecting.append(frame)
            if len(self._collecting) >= self._post_roll_frames:
                self._finish()
            return
        self._recent.append(frame)

    def begin_clip(self, object_key: str) -> None:
        """Starts a clip at a detection, seeded with the buffered pre-roll."""
        if self._collecting is not None:
            # Already recording; the ongoing clip covers this detection too.
            return
        self._pending_key = object_key
        self._collecting = list(self._recent)

    # -- internals ---------------------------------------------------------

    def _finish(self) -> None:
        frames = self._collecting or []
        key = self._pending_key
        self._collecting = None
        self._pending_key = None
        self._recent.clear()

        if not frames or key is None:
            return

        height, width = frames[0].shape[:2]
        spec = ClipSpec(
            object_key=key, frames=frames, fps=self._fps, width=width, height=height
        )
        try:
            self._queue.put_nowait(spec)
        except queue.Full:
            # Dropping a clip is strictly better than stalling detection or growing
            # without bound; the event itself is already reported either way.
            log.warning("Evidence queue full — dropping clip %s", key)

    def _drain(self) -> None:
        while not self._stop.is_set():
            try:
                spec = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if spec is None:
                return
            try:
                self._write_and_upload(spec)
            except Exception:  # noqa: BLE001 - evidence must never kill the agent
                log.exception("Failed to store clip %s", spec.object_key)
            finally:
                self._queue.task_done()

    def _write_and_upload(self, spec: ClipSpec) -> None:
        import cv2  # noqa: PLC0415 - lazy, same reason as camera.py

        self._output_dir.mkdir(parents=True, exist_ok=True)
        local = self._output_dir / Path(spec.object_key).name

        writer = cv2.VideoWriter(
            str(local), cv2.VideoWriter_fourcc(*"mp4v"), spec.fps, (spec.width, spec.height)
        )
        if not writer.isOpened():
            log.error("Could not open VideoWriter for %s", local)
            return
        for frame in spec.frames:
            writer.write(frame)
        writer.release()

        log.info(
            "Wrote clip %s (%s frames, %.1f KB)",
            local.name,
            len(spec.frames),
            local.stat().st_size / 1024,
        )

        if self._uploader is None:
            return

        try:
            self._uploader.upload(local, spec.object_key)
        except Exception:
            # Deliberately NOT in a `finally`: deleting the local copy after a failed
            # upload would destroy the only remaining record of the incident. Keeping
            # it costs disk; losing it costs the evidence.
            log.exception(
                "Upload failed for %s — keeping the local copy at %s", spec.object_key, local
            )
            raise

        if not self._keep_local:
            # Only once the object store definitely has it. The store is the record; a
            # local copy on a Raspberry Pi's SD card would fill it within days.
            local.unlink(missing_ok=True)

    def close(self) -> None:
        # Flush a clip still collecting post-roll, so a shutdown mid-incident does not
        # silently discard the evidence for it.
        if self._collecting is not None:
            self._finish()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        self._stop.set()
        self._worker.join(timeout=10.0)


class ClipUploader:
    """Uploads clips to an S3-compatible store (MinIO in development).

    boto3 is imported lazily for the same reason as cv2: an agent that never records
    evidence should not need the dependency installed.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key: str,
        secret_key: str,
        region: str = "us-east-1",
        public_base_url: str | None = None,
    ) -> None:
        self.bucket = bucket
        self.public_base_url = (public_base_url or endpoint).rstrip("/")
        try:
            import boto3  # noqa: PLC0415
            from botocore.config import Config  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError(
                "Clip upload needs boto3: pip install -r requirements-hardware.txt"
            ) from exc

        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            # Path-style addressing: MinIO does not do virtual-host buckets by default.
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}),
        )
        self._ensure_bucket()

    def _ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self.bucket)
        except Exception:  # noqa: BLE001 - any failure here means "try creating it"
            try:
                self._client.create_bucket(Bucket=self.bucket)
                log.info("Created evidence bucket %s", self.bucket)
            except Exception as exc:  # noqa: BLE001
                log.warning("Could not ensure bucket %s exists: %s", self.bucket, exc)

    def upload(self, path: Path, object_key: str) -> None:
        self._client.upload_file(
            str(path), self.bucket, object_key, ExtraArgs={"ContentType": "video/mp4"}
        )
        log.info("Uploaded evidence to s3://%s/%s", self.bucket, object_key)

    def url_for(self, object_key: str) -> str:
        return f"{self.public_base_url}/{self.bucket}/{object_key}"
