import { useState } from 'react';

import { api } from '../lib/api';
import { useSessionStore } from '../stores/session.store';

/**
 * Tidies a pasted credential.
 *
 * Keys get copied out of documentation and chat, which reliably picks up the
 * punctuation around them — a trailing full stop after a code span, or wrapping
 * backticks and quotes. The hub then rejects a key that looks correct to the eye, and
 * the redacted value in its log is the only clue. Since none of these characters can
 * appear in a real credential, stripping them removes a whole class of confusing
 * failure without ever mangling a valid key.
 */
function cleanCredential(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"<]+/, '')
    .replace(/[`'">]+$/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

/**
 * Collects a credential and verifies it before accepting it.
 *
 * Verifying up front means a typo fails here with one clear message, rather than as a
 * wall of 401s across every panel. The credential is kept in sessionStorage, not
 * localStorage: it can disarm a building, so it should not outlive the tab.
 */
export function SignIn() {
  const signIn = useSessionStore((s) => s.signIn);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    setChecking(true);
    setError(null);

    // Store first so the request layer picks it up, then roll back on rejection —
    // leaving a known-bad credential in the store would break every later request.
    signIn(cleanCredential(value));
    try {
      await api.me();
    } catch (err) {
      useSessionStore.getState().signOut();
      setError(err instanceof Error ? err.message : 'Could not reach the hub.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <h1>Security Hub</h1>
        <p className="muted">
          Enter a viewer, operator, or admin credential. The hub decides what you can do — this
          page only reflects it. Agent tokens cannot sign in.
        </p>

        <label htmlFor="credential">Credential</label>
        <input
          id="credential"
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="VIEWER_KEY / OPERATOR_KEY / ADMIN_KEY"
          autoFocus
        />

        {error && <p className="signin-error">{error}</p>}

        <button type="submit" disabled={checking || value.trim().length === 0}>
          {checking ? 'Checking…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
