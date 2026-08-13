"""Video evidence capture (roadmap item 5).

The behaviours worth locking down are the ones that make a clip useful rather than
merely present: pre-roll (so the subject's entry is captured, not just the middle of
their walk), bounded queueing (so a tripping camera cannot exhaust memory), and
flush-on-shutdown (so stopping mid-incident does not discard that incident).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from security_agent.evidence import MAX_QUEUED_CLIPS, EvidenceRecorder


def frame(value: int = 128) -> np.ndarray:
    return np.full((48, 64, 3), value, dtype=np.uint8)


@pytest.fixture
def recorder(tmp_path: Path) -> EvidenceRecorder:
    r = EvidenceRecorder(
        "cam-test",
        uploader=None,
        output_dir=tmp_path,
        pre_roll_seconds=1.0,
        post_roll_seconds=1.0,
        fps=5.0,  # 5 pre-roll frames, 5 post-roll frames
        keep_local=True,
    )
    yield r
    r.close()


# -- pre-roll ----------------------------------------------------------------


def test_preroll_buffer_is_bounded_to_the_configured_window(recorder: EvidenceRecorder) -> None:
    for _ in range(50):
        recorder.observe(frame())

    # 1.0s at 5fps => 5 frames retained, not 50.
    assert len(recorder._recent) == 5


def test_a_clip_starts_with_the_buffered_preroll(recorder: EvidenceRecorder) -> None:
    # This is what captures a subject entering: MOG2 only fires once they are already
    # well into frame, so a clip beginning at the trigger misses the entry.
    for value in (10, 20, 30):
        recorder.observe(frame(value))

    recorder.begin_clip("cam-test/clip.mp4")

    assert recorder._collecting is not None
    assert len(recorder._collecting) == 3
    assert recorder._collecting[0][0][0][0] == 10


def test_frames_after_the_trigger_extend_the_clip(recorder: EvidenceRecorder) -> None:
    recorder.observe(frame())
    recorder.begin_clip("cam-test/clip.mp4")

    recorder.observe(frame())
    recorder.observe(frame())

    assert len(recorder._collecting) == 3


def test_a_second_trigger_during_recording_is_absorbed(recorder: EvidenceRecorder) -> None:
    # The in-progress clip already covers the ongoing motion; starting a second would
    # produce two near-identical clips of one incident.
    recorder.observe(frame())
    recorder.begin_clip("cam-test/first.mp4")
    recorder.begin_clip("cam-test/second.mp4")

    assert recorder._pending_key == "cam-test/first.mp4"


# -- completion --------------------------------------------------------------


def test_a_clip_is_written_once_the_postroll_completes(
    tmp_path: Path, recorder: EvidenceRecorder
) -> None:
    recorder.observe(frame())
    recorder.begin_clip("cam-test/done.mp4")
    for _ in range(6):  # exceeds the 5-frame post-roll
        recorder.observe(frame())

    recorder._queue.join()

    written = list(tmp_path.glob("*.mp4"))
    assert len(written) == 1
    assert written[0].name == "done.mp4"
    assert written[0].stat().st_size > 0


def test_recording_state_resets_so_the_next_detection_records_again(
    recorder: EvidenceRecorder,
) -> None:
    recorder.observe(frame())
    recorder.begin_clip("cam-test/one.mp4")
    for _ in range(6):
        recorder.observe(frame())

    assert recorder._collecting is None
    assert recorder._pending_key is None


def test_shutdown_flushes_a_clip_still_collecting_postroll(tmp_path: Path) -> None:
    # Stopping mid-incident must not silently discard the evidence for it.
    r = EvidenceRecorder(
        "cam-test",
        uploader=None,
        output_dir=tmp_path,
        pre_roll_seconds=1.0,
        post_roll_seconds=10.0,  # deliberately never completes on its own
        fps=5.0,
        keep_local=True,
    )
    r.observe(frame())
    r.begin_clip("cam-test/partial.mp4")
    r.observe(frame())

    r.close()

    assert (tmp_path / "partial.mp4").exists()


# -- robustness --------------------------------------------------------------


def test_the_clip_queue_is_bounded(tmp_path: Path) -> None:
    # A camera tripping constantly must not accumulate unbounded encode work; dropping
    # a clip is strictly better than stalling detection or exhausting memory.
    r = EvidenceRecorder(
        "cam-test",
        uploader=None,
        output_dir=tmp_path,
        pre_roll_seconds=0.2,
        post_roll_seconds=0.2,
        fps=5.0,
        keep_local=True,
    )
    try:
        assert r._queue.maxsize == MAX_QUEUED_CLIPS
    finally:
        r.close()


def test_post_roll_ms_is_exposed_for_event_metadata(recorder: EvidenceRecorder) -> None:
    # The camera publishes this so a consumer knows how long to wait before the clip
    # object can exist, instead of treating a 404 as "lost".
    assert recorder.post_roll_ms == 1000


class Boom:
    """An uploader that always fails."""

    def upload(self, path: Path, object_key: str) -> None:
        raise RuntimeError("object store unreachable")

    def url_for(self, object_key: str) -> str:
        return f"http://store/{object_key}"


def build_failing(tmp_path: Path, *, keep_local: bool) -> EvidenceRecorder:
    return EvidenceRecorder(
        "cam-test",
        uploader=Boom(),
        output_dir=tmp_path,
        pre_roll_seconds=0.2,
        post_roll_seconds=0.2,
        fps=5.0,
        keep_local=keep_local,
    )


def record_one(r: EvidenceRecorder, key: str) -> None:
    r.observe(frame())
    r.begin_clip(key)
    for _ in range(3):
        r.observe(frame())
    r._queue.join()


def test_an_upload_failure_does_not_kill_the_worker(tmp_path: Path) -> None:
    r = build_failing(tmp_path, keep_local=True)
    try:
        record_one(r, "cam-test/fails.mp4")

        assert r._worker.is_alive()
    finally:
        r.close()


def test_a_failed_upload_keeps_the_local_clip_even_when_not_keeping_locals(
    tmp_path: Path,
) -> None:
    # The bug this guards: deleting the local copy in a `finally` destroyed the only
    # remaining record whenever the object store was unreachable. Keeping it costs
    # disk; losing it costs the evidence.
    r = build_failing(tmp_path, keep_local=False)
    try:
        record_one(r, "cam-test/orphan.mp4")

        assert (tmp_path / "orphan.mp4").exists()
    finally:
        r.close()
