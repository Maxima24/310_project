import { AGENT_ID_MAX_LENGTH, AGENT_ID_PATTERN } from '@cpe310/contracts';

/**
 * Builds the command that starts a camera agent on the machine its camera is plugged
 * into.
 *
 * THE SIGNATURE IS THE SECURITY PROPERTY. This function accepts no credential and the
 * dashboard never fetches one, so the generated text cannot contain the bootstrap key
 * however it is called. That key enrolls agents; putting it on screen would hand every
 * operator who can open this page the ability to enroll anything, which is exactly the
 * privilege the role split exists to withhold. The command references the key as an
 * environment variable the person already has on the machine where the agent runs.
 */

export type Shell = 'powershell' | 'bash';

export interface CameraAgentOptions {
  agentId: string;
  location: string;
  /** `0` for the first local camera, or an RTSP URL. */
  source: string;
  streamFps: number;
  streamWidth: number;
  recordEvidence: boolean;
  /** Only emitted when it differs from the agent's own default. */
  hubUrl?: string;
}

/** Turns "Front Office" into "front-office", for a sensible default id. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function suggestAgentId(location: string): string {
  const slug = slugify(location);
  return slug ? `camera-${slug}` : 'camera-1';
}

/** Null when valid; otherwise the reason, phrased for the person typing. */
export function validateAgentId(agentId: string): string | null {
  if (!agentId.trim()) return 'Give the camera an id.';
  if (agentId.length > AGENT_ID_MAX_LENGTH) {
    return `Ids are at most ${AGENT_ID_MAX_LENGTH} characters.`;
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return 'Use only letters, numbers, dot, underscore and hyphen — the id appears in a URL.';
  }
  return null;
}

/** Single-quotes for POSIX, single-quotes with doubling for PowerShell. */
function quote(value: string, shell: Shell): string {
  return shell === 'powershell'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line that loads the bootstrap key from the repo `.env` WITHOUT printing it.
 *
 * Deliberately not `cat .env` or an echo of the value: the most likely place this gets
 * run is a screen-shared terminal.
 */
function loadKeyLine(shell: Shell): string {
  return shell === 'powershell'
    ? '$env:AGENT_BOOTSTRAP_KEY = (Select-String -Path .env -Pattern \'^AGENT_BOOTSTRAP_KEY=\' | ' +
        'Select-Object -First 1).Line -replace \'^AGENT_BOOTSTRAP_KEY=\', \'\''
    : "export AGENT_BOOTSTRAP_KEY=$(grep -m1 '^AGENT_BOOTSTRAP_KEY=' .env | cut -d= -f2-)";
}

export function buildCameraAgentCommand(
  options: CameraAgentOptions,
  shell: Shell,
): string {
  const args = [
    '--type camera',
    `--id ${options.agentId}`,
    `--location ${quote(options.location, shell)}`,
    '--real',
    `--source ${options.source === '0' ? '0' : quote(options.source, shell)}`,
    // Without --stream the agent detects motion but publishes no frames, and the tile
    // reads "No signal" while the agent looks perfectly healthy. It is the single most
    // common way this goes wrong, so it is never optional here.
    '--stream',
    `--stream-fps ${options.streamFps}`,
    `--stream-width ${options.streamWidth}`,
  ];

  if (options.recordEvidence) args.push('--record-evidence');
  if (options.hubUrl) args.push(`--hub ${quote(options.hubUrl, shell)}`);

  // Wrapped across lines so a long command stays readable in the panel and in whatever
  // terminal it is pasted into.
  const continuation = shell === 'powershell' ? '`' : '\\';
  const [first, ...rest] = args;
  const run = [
    `python run_agent.py ${first} ${continuation}`,
    ...rest.map((arg, i) => (i === rest.length - 1 ? `  ${arg}` : `  ${arg} ${continuation}`)),
  ].join('\n');

  return [
    '# From the repo root: make the enrollment key available, without printing it.',
    loadKeyLine(shell),
    '',
    'cd agents',
    run,
  ].join('\n');
}
