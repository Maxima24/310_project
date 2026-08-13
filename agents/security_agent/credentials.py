"""Agent credential storage (roadmap item 2).

An agent holds two secrets with very different lifetimes:

* the **bootstrap key**, from the environment, used only to enroll;
* its **own token**, issued by the hub at enrollment and used for everything else.

The token is persisted so a restart does not force a rotation. That matters beyond
tidiness: every rotation is logged by the hub as a security-relevant event, and an
agent that rotated on every restart would bury a genuine unexpected rotation in
noise.
"""

from __future__ import annotations

import logging
import os
import stat
from pathlib import Path

log = logging.getLogger(__name__)

#: Default directory for token files. Overridable with --token-dir, and per-agent so
#: two agents on one host never share a credential.
DEFAULT_TOKEN_DIR = Path.home() / ".cpe310"


class TokenStore:
    """Reads and writes one agent's token file."""

    def __init__(self, agent_id: str, directory: Path | None = None) -> None:
        self.agent_id = agent_id
        self.directory = Path(directory) if directory else DEFAULT_TOKEN_DIR
        self.path = self.directory / f"{agent_id}.token"

    def load(self) -> str | None:
        try:
            token = self.path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None
        except OSError as exc:
            # An unreadable token file must not stop the agent: it can always fall
            # back to enrolling again with the bootstrap key.
            log.warning("Could not read %s (%s); will re-enroll", self.path, exc)
            return None
        return token or None

    def save(self, token: str) -> None:
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.path.write_text(token, encoding="utf-8")
            self._restrict_permissions()
            log.info("Stored agent token at %s", self.path)
        except OSError as exc:
            # Losing the file only costs a rotation on next start, so this is a
            # warning rather than fatal — refusing to run would be worse.
            log.warning(
                "Could not persist token to %s (%s); the agent will work now but "
                "will re-enroll (and rotate its token) on next start",
                self.path,
                exc,
            )

    def clear(self) -> None:
        try:
            self.path.unlink(missing_ok=True)
        except OSError as exc:
            log.warning("Could not remove stale token %s (%s)", self.path, exc)

    def _restrict_permissions(self) -> None:
        """Owner-only, best effort.

        chmod is a no-op for practical purposes on Windows, where the file inherits
        the user profile directory's ACL instead — which is why the default location
        is under the user's home rather than a shared temp directory.
        """
        try:
            os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            log.debug("Could not chmod %s (expected on Windows)", self.path)
