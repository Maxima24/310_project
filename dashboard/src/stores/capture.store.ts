import type { BrowserCameraSessionResponse } from '@cpe310/contracts';
import { create } from 'zustand';

/**
 * The browser's own publishing session.
 *
 * IN MEMORY ONLY — not persisted, and deliberately not in `sessionStorage` either.
 *
 * The operator credential uses `sessionStorage` because it must not outlive the tab. A
 * PUBLISHING token has a stricter requirement: it must not outlive the PAGE. sessionStorage
 * survives a reload, and a publishing token surviving a reload means a tab could quietly
 * resume using the camera without anyone deciding to. In memory means a reload ends the
 * session and the camera light goes out, which is the correct failure.
 *
 * One session per tab, not a map: a single tab has one operator in front of it, and
 * letting one page publish several cameras at once is capability nobody asked for.
 */

export interface CaptureState {
  session: BrowserCameraSessionResponse | null;
  /** The device the operator chose, so a reconnect does not silently switch cameras. */
  deviceId: string | null;
  setSession: (session: BrowserCameraSessionResponse | null) => void;
  setDeviceId: (deviceId: string | null) => void;
  clear: () => void;
}

export const useCaptureStore = create<CaptureState>((set) => ({
  session: null,
  deviceId: null,
  setSession: (session) => set({ session }),
  setDeviceId: (deviceId) => set({ deviceId }),
  clear: () => set({ session: null }),
}));

/** Read the publishing token outside React — the capture loop is not a component. */
export function currentCaptureSession(): BrowserCameraSessionResponse | null {
  return useCaptureStore.getState().session;
}
