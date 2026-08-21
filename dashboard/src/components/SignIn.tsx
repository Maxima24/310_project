import { MAX_OPERATOR_LABEL_LENGTH } from '@cpe310/contracts';
import { useState } from 'react';

import { Button, Icon } from './ui';
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
  const remembered = useSessionStore((s) => s.label);
  const [value, setValue] = useState('');
  const [label, setLabel] = useState(remembered);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    setChecking(true);
    setError(null);

    // Store first so the request layer picks it up, then roll back on rejection —
    // leaving a known-bad credential in the store would break every later request.
    signIn(cleanCredential(value), label.trim());
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
        <div className="signin-brand">
          <span className="brand-mark">
            <Icon name="shield" size={17} />
          </span>
          <h1>Sentinel</h1>
        </div>

        <p>
          Enter a viewer, operator, or admin credential. The hub decides what you can do — this
          page only reflects it. Agent tokens cannot sign in.
        </p>

        <div className="field">
          <label className="label" htmlFor="credential">
            Credential
          </label>
          <input
            id="credential"
            className="input"
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="VIEWER_KEY / OPERATOR_KEY / ADMIN_KEY"
            autoFocus
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="operator-label">
            Your name <span className="label-optional">optional</span>
          </label>
          <input
            id="operator-label"
            className="input"
            type="text"
            maxLength={MAX_OPERATOR_LABEL_LENGTH}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. A. Rodriguez"
          />
          {/* Said plainly, because a name the system cannot check must never be read as
              one it can. Credentials are shared per role, so this is a shift-log entry,
              not identity — and the audit view repeats the same caveat. */}
          <p className="field-hint">
            Recorded against what you do here. The hub cannot verify it — credentials are
            shared per role, so this is a claim, not proof.
          </p>
        </div>

        {error && <p className="form-error">{error}</p>}

        <Button
          type="submit"
          variant="primary"
          disabled={checking || value.trim().length === 0}
          style={{ marginTop: 'var(--s2)', height: 40 }}
        >
          {checking ? 'Checking…' : 'Connect'}
        </Button>
      </form>
    </div>
  );
}
