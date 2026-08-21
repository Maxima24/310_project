import { AgentOrigin, MAX_CONCURRENT_STREAMS, type CameraStatusView } from '@cpe310/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { selectAutoWatch, useUiStore } from './ui.store';

function camera(agentId: string, overrides: Partial<CameraStatusView> = {}): CameraStatusView {
  return {
    agentId,
    location: agentId,
    streaming: true,
    frameAgeMs: 40,
    width: 640,
    height: 480,
    fps: 5,
    viewers: 0,
    origin: AgentOrigin.Device,
    ...overrides,
  };
}

describe('selectAutoWatch', () => {
  it('starts live cameras with no interaction — the whole point of auto-start', () => {
    expect(selectAutoWatch([camera('a'), camera('b')], [], [])).toEqual(['a', 'b']);
  });

  it('never exceeds the concurrent stream cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => camera(`cam-${i}`));

    expect(selectAutoWatch(many, [], [])).toHaveLength(MAX_CONCURRENT_STREAMS);
  });

  it('picks in a deterministic order, by location then id', () => {
    // Not "most recent frames" or "fewest viewers": those reshuffle the wall under the
    // operator as an fps figure wobbles, and make a support question unanswerable.
    const cameras = [
      camera('z', { location: 'Atrium' }),
      camera('a', { location: 'Zoo' }),
      camera('m', { location: 'Atrium' }),
    ];

    expect(selectAutoWatch(cameras, [], [])).toEqual(['m', 'z', 'a']);
  });

  it('skips cameras that are not streaming', () => {
    expect(selectAutoWatch([camera('a', { streaming: false }), camera('b')], [], [])).toEqual(['b']);
  });

  it('skips opted-out cameras', () => {
    expect(selectAutoWatch([camera('a'), camera('b')], [], ['a'])).toEqual(['b']);
  });

  it('KEEPS a slot when a watched camera stops streaming', () => {
    // The anti-thrash property. Releasing on `streaming: false` would let a flapping
    // camera hand its slot to another one the moment it stutters, and never get it
    // back — the wall would reshuffle itself on every poll.
    const cameras = [camera('a', { streaming: false }), camera('b'), camera('c')];

    expect(selectAutoWatch(cameras, ['a'], [])).toContain('a');
  });

  it('releases a slot only when the camera vanishes from the list entirely', () => {
    // e.g. decommissioned, or outside a zone-restricted credential's scope.
    expect(selectAutoWatch([camera('b')], ['a'], [])).toEqual(['b']);
  });

  it('never evicts an existing watch to make room', () => {
    const held = Array.from({ length: MAX_CONCURRENT_STREAMS }, (_, i) => `old-${i}`);
    const cameras = [...held.map((id) => camera(id)), camera('new')];

    expect(selectAutoWatch(cameras, held, [])).toEqual(held);
  });

  it('returns the SAME array reference when nothing changed', () => {
    // The poll runs every 10s; a fresh array each time would re-render every tile.
    const cameras = [camera('a'), camera('b')];
    const current = ['a', 'b'];

    expect(selectAutoWatch(cameras, current, [])).toBe(current);
  });

  it('returns a new reference when the set genuinely changes', () => {
    const current = ['a'];

    expect(selectAutoWatch([camera('a'), camera('b')], current, [])).not.toBe(current);
  });
});

describe('useUiStore camera actions', () => {
  beforeEach(() => {
    useUiStore.setState({ cameraWatch: [], cameraOptOut: [], cameraPaused: [] });
  });

  it('stopWatching removes the tile AND remembers not to restart it', () => {
    // Without the opt-out the next reconcile would re-add it seconds later, and the
    // Stop button would look broken.
    useUiStore.setState({ cameraWatch: ['a', 'b'] });

    useUiStore.getState().stopWatchingCamera('a');

    expect(useUiStore.getState().cameraWatch).toEqual(['b']);
    expect(useUiStore.getState().cameraOptOut).toContain('a');
  });

  it('startWatching clears the opt-out so a stopped camera can come back', () => {
    useUiStore.setState({ cameraOptOut: ['a'] });

    useUiStore.getState().startWatchingCamera('a');

    expect(useUiStore.getState().cameraOptOut).not.toContain('a');
    expect(useUiStore.getState().cameraWatch).toContain('a');
  });

  it('refuses to start past the cap rather than evicting someone', () => {
    const full = Array.from({ length: MAX_CONCURRENT_STREAMS }, (_, i) => `cam-${i}`);
    useUiStore.setState({ cameraWatch: full });

    useUiStore.getState().startWatchingCamera('extra');

    expect(useUiStore.getState().cameraWatch).toEqual(full);
  });

  it('does not duplicate an already-watched camera', () => {
    useUiStore.setState({ cameraWatch: ['a'] });

    useUiStore.getState().startWatchingCamera('a');

    expect(useUiStore.getState().cameraWatch).toEqual(['a']);
  });

  it('resumeAll clears every opt-out, which is the undo for Stop', () => {
    useUiStore.setState({ cameraOptOut: ['a', 'b'] });

    useUiStore.getState().resumeAllCameras();

    expect(useUiStore.getState().cameraOptOut).toEqual([]);
  });

  it('clears a stale pause when a camera is stopped', () => {
    useUiStore.setState({ cameraWatch: ['a'], cameraPaused: ['a'] });

    useUiStore.getState().stopWatchingCamera('a');

    expect(useUiStore.getState().cameraPaused).not.toContain('a');
  });

  it('toggles pause both ways', () => {
    useUiStore.getState().toggleCameraPaused('a');
    expect(useUiStore.getState().cameraPaused).toEqual(['a']);

    useUiStore.getState().toggleCameraPaused('a');
    expect(useUiStore.getState().cameraPaused).toEqual([]);
  });

  it('persists the opt-out but NOT the watch or pause sets', () => {
    // A watch list restored from last session would pin every slot to cameras that are
    // dead now, starving the live ones.
    useUiStore.setState({ cameraWatch: ['a'], cameraOptOut: ['b'], cameraPaused: ['c'] });

    const persisted = JSON.parse(window.localStorage.getItem('cpe310.ui') ?? '{}');

    expect(persisted.state.cameraOptOut).toEqual(['b']);
    expect(persisted.state).not.toHaveProperty('cameraWatch');
    expect(persisted.state).not.toHaveProperty('cameraPaused');
  });
});
