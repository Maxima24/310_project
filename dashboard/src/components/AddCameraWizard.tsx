import { useMemo, useState } from 'react';

import { Banner, Button, Icon } from './ui';
import {
  buildCameraAgentCommand,
  suggestAgentId,
  validateAgentId,
  type Shell,
} from '../lib/agent-command';
import { useAgents, useCameras } from '../lib/queries';
import { useUiStore } from '../stores/ui.store';

/**
 * Guided setup for a camera on dedicated hardware.
 *
 * There is no hub endpoint behind this, and that is the feature's main virtue: the
 * bootstrap enrollment path already does everything, so this is a form, a command, and
 * a status watcher. A browser cannot start a process on the machine a camera is plugged
 * into, so pretending to "add a device" remotely would be theatre — what it can do is
 * remove every chance to get the command wrong, and then tell you the moment it worked.
 */
export function AddCameraWizard({ onClose }: { onClose: () => void }) {
  const [location, setLocation] = useState('');
  const [agentId, setAgentId] = useState('');
  const [source, setSource] = useState('0');
  const [streamFps, setStreamFps] = useState(5);
  const [streamWidth, setStreamWidth] = useState(640);
  const [recordEvidence, setRecordEvidence] = useState(false);
  const [shell, setShell] = useState<Shell>(
    navigator.platform.startsWith('Win') ? 'powershell' : 'bash',
  );
  const [copied, setCopied] = useState(false);

  // A faster poll only while this is open; the interval reverts on unmount.
  const agents = useAgents(3_000);
  const cameras = useCameras(true);
  const startWatching = useUiStore((s) => s.startWatchingCamera);

  const effectiveId = agentId || suggestAgentId(location);
  const idError = location || agentId ? validateAgentId(effectiveId) : null;

  const command = useMemo(
    () =>
      buildCameraAgentCommand(
        {
          agentId: effectiveId,
          location: location || 'Unnamed',
          source,
          streamFps,
          streamWidth,
          recordEvidence,
        },
        shell,
      ),
    [effectiveId, location, source, streamFps, streamWidth, recordEvidence, shell],
  );

  const existing = agents.data?.find((agent) => agent.id === effectiveId);
  const camera = cameras.data?.find((c) => c.agentId === effectiveId);

  // Was it already there before this wizard opened? That changes the warning from
  // "success" to "you are about to rotate a working agent's token".
  const [knownBefore] = useState(() => new Set(agents.data?.map((a) => a.id) ?? []));
  const isRotation = Boolean(existing) && knownBefore.has(effectiveId);
  const arrived = Boolean(existing) && !knownBefore.has(effectiveId);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be refused; the command is selectable on screen anyway.
    }
  };

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h3 className="wizard-title">
          <Icon name="camera" size={15} />
          Add a dedicated camera
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="schedule-form-grid">
        <div className="field">
          <label className="label" htmlFor="cam-location">
            Where is it?
          </label>
          <input
            id="cam-location"
            className="input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Front Office"
            autoFocus
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="cam-id">
            Agent id
          </label>
          <input
            id="cam-id"
            className="input"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder={suggestAgentId(location) || 'camera-1'}
          />
          <p className="field-hint">
            Stable name for this camera. Restarting it reuses the same id, which is how
            its history survives.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="cam-source">
            Source
          </label>
          <input
            id="cam-source"
            className="input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="0"
          />
          <p className="field-hint">
            <span className="mono">0</span> for the machine's first camera, or an RTSP URL.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="cam-fps">
            Frame rate
          </label>
          <input
            id="cam-fps"
            className="input"
            type="number"
            min={1}
            max={15}
            value={streamFps}
            onChange={(e) => setStreamFps(Number(e.target.value))}
          />
          <p className="field-hint">
            Each viewer holds a connection open, so higher is not free.
          </p>
        </div>
      </div>

      <label className="checkline">
        <input
          type="checkbox"
          checked={recordEvidence}
          onChange={(e) => setRecordEvidence(e.target.checked)}
        />
        Record a short clip when motion is detected
      </label>

      {idError && <p className="form-error">{idError}</p>}

      {isRotation && (
        <Banner tone="critical" icon="alert">
          An agent called <span className="mono">{effectiveId}</span> already exists. Running
          this command <strong>rotates its token</strong> — whatever that agent is currently
          using stops working immediately. Choose a different id unless that is what you want.
        </Banner>
      )}

      <div className="wizard-step">
        <div className="wizard-step-head">
          <span className="label">Run this on the machine the camera is plugged into</span>
          <div className="segmented" role="group" aria-label="Shell">
            {(['powershell', 'bash'] as Shell[]).map((option) => (
              <button
                key={option}
                className={`segmented-item ${shell === option ? 'is-active' : ''}`}
                aria-pressed={shell === option}
                onClick={() => setShell(option)}
              >
                {option === 'powershell' ? 'PowerShell' : 'bash'}
              </button>
            ))}
          </div>
        </div>

        <pre className="codeblock">{command}</pre>

        <div className="wizard-step-actions">
          <Button size="sm" icon={copied ? 'check' : 'clip'} onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {/* Said plainly because someone will look for the key in this box and worry
              that it is missing. Its absence is the point. */}
          <span className="field-hint">
            No secret appears above. The enrollment key is read from your{' '}
            <span className="mono">.env</span> on that machine — the dashboard never sees it.
          </span>
        </div>
      </div>

      <Banner tone="info" icon="alert">
        This runs <strong>natively</strong>, not in Docker. Docker Desktop on Windows and
        macOS runs containers in a VM with no USB passthrough, so{' '}
        <span className="mono">/dev/video0</span> does not exist there — the agent talks to
        the containerised hub over the network instead.
      </Banner>

      <div className="wizard-status">
        {arrived && camera?.streaming ? (
          <>
            <Icon name="check" size={15} />
            <span>
              <strong>{effectiveId}</strong> is enrolled and sending frames.
            </span>
            <Button
              size="sm"
              onClick={() => {
                startWatching(effectiveId);
                onClose();
              }}
            >
              Watch it
            </Button>
          </>
        ) : arrived ? (
          <>
            <Icon name="alert" size={15} />
            <span>
              <strong>{effectiveId}</strong> enrolled but is not publishing frames — it was
              probably started without <span className="mono">--stream</span>.
            </span>
          </>
        ) : (
          <>
            <span className="spinner" />
            <span>
              Waiting for <strong>{effectiveId}</strong> to enrol. If nothing happens: the
              key is not set on that machine, or <span className="mono">--hub</span> points
              somewhere else.
            </span>
          </>
        )}
      </div>
    </div>
  );
}
