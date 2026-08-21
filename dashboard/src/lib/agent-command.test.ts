import { describe, expect, it } from 'vitest';

import {
  buildCameraAgentCommand,
  slugify,
  suggestAgentId,
  validateAgentId,
  type CameraAgentOptions,
} from './agent-command';

const BASE: CameraAgentOptions = {
  agentId: 'camera-office',
  location: 'Front Office',
  source: '0',
  streamFps: 5,
  streamWidth: 640,
  recordEvidence: false,
};

describe('buildCameraAgentCommand', () => {
  it('NEVER contains a secret, only a reference to one', () => {
    // The invariant the signature already enforces — the function takes no credential —
    // asserted anyway, because this is the property that keeps the enrollment key out
    // of every operator's browser.
    const command = buildCameraAgentCommand(BASE, 'bash');

    expect(command).toContain('AGENT_BOOTSTRAP_KEY');
    expect(command).not.toMatch(/AGENT_BOOTSTRAP_KEY=['"]?[A-Za-z0-9]/);
    expect(command).not.toContain('dev-bootstrap');
  });

  it('always passes --stream, the most common way this goes wrong', () => {
    // Without it the agent enrols, looks healthy, detects motion — and publishes no
    // frames, so the tile reads "No signal" with nothing obviously broken.
    expect(buildCameraAgentCommand(BASE, 'bash')).toContain('--stream');
  });

  it('includes --real, since a simulated camera produces no picture', () => {
    expect(buildCameraAgentCommand(BASE, 'bash')).toContain('--real');
  });

  it('quotes a location containing spaces', () => {
    expect(buildCameraAgentCommand(BASE, 'bash')).toContain("--location 'Front Office'");
  });

  it('leaves a numeric source unquoted but quotes an RTSP URL', () => {
    expect(buildCameraAgentCommand(BASE, 'bash')).toContain('--source 0');
    expect(
      buildCameraAgentCommand({ ...BASE, source: 'rtsp://cam/1' }, 'bash'),
    ).toContain("--source 'rtsp://cam/1'");
  });

  it('escapes a quote in a location rather than breaking the command', () => {
    const bash = buildCameraAgentCommand({ ...BASE, location: "Bob's Desk" }, 'bash');
    const ps = buildCameraAgentCommand({ ...BASE, location: "Bob's Desk" }, 'powershell');

    expect(bash).toContain(`'Bob'\\''s Desk'`);
    expect(ps).toContain("'Bob''s Desk'");
  });

  it('adds --record-evidence only when asked', () => {
    expect(buildCameraAgentCommand(BASE, 'bash')).not.toContain('--record-evidence');
    expect(
      buildCameraAgentCommand({ ...BASE, recordEvidence: true }, 'bash'),
    ).toContain('--record-evidence');
  });

  it('uses the right line continuation per shell', () => {
    expect(buildCameraAgentCommand(BASE, 'bash')).toContain('\\\n');
    expect(buildCameraAgentCommand(BASE, 'powershell')).toContain('`\n');
  });

  it('does not leave a dangling continuation on the last argument', () => {
    // A trailing continuation makes the shell wait for more input, which reads as a hang.
    for (const shell of ['bash', 'powershell'] as const) {
      const command = buildCameraAgentCommand(BASE, shell);
      expect(command.trimEnd().endsWith('\\')).toBe(false);
      expect(command.trimEnd().endsWith('`')).toBe(false);
    }
  });

  it('loads the key without printing it', () => {
    // The likeliest place this gets run is a screen-shared terminal.
    expect(buildCameraAgentCommand(BASE, 'bash')).not.toMatch(/\b(cat|echo)\s+\.env/);
  });
});

describe('slugify and suggestAgentId', () => {
  it('turns a location into a usable id', () => {
    expect(suggestAgentId('Front Office')).toBe('camera-front-office');
  });

  it('strips punctuation that an id may not contain', () => {
    expect(slugify('Bay #3 — West!')).toBe('bay-3-west');
  });

  it('falls back to a valid id for an empty or unusable location', () => {
    expect(suggestAgentId('')).toBe('camera-1');
    expect(suggestAgentId('!!!')).toBe('camera-1');
  });

  it('always suggests something the hub would accept', () => {
    for (const location of ['Front Office', '!!!', '', 'Ünïcødé', 'a'.repeat(200)]) {
      expect(validateAgentId(suggestAgentId(location))).toBeNull();
    }
  });
});

describe('validateAgentId', () => {
  it('accepts the characters the hub accepts', () => {
    expect(validateAgentId('camera-lobby_2.a')).toBeNull();
  });

  it('rejects characters that would break the URL it appears in', () => {
    expect(validateAgentId('camera lobby')).toMatch(/letters, numbers/);
    expect(validateAgentId('camera/lobby')).toMatch(/letters, numbers/);
  });

  it('rejects an empty id and one over the length limit', () => {
    expect(validateAgentId('   ')).toMatch(/id/i);
    expect(validateAgentId('c'.repeat(65))).toMatch(/at most/);
  });
});
