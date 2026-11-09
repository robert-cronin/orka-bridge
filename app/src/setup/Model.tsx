import { useEffect, useRef, useState } from 'react';
import { connectModel } from './modelState';

export type ModelState = 'idle' | 'connecting' | 'connected' | 'failed';
export default function Model({ enabled, paused = false, onState, onSettled }: {
  enabled: boolean; paused?: boolean; onState?: (state: ModelState) => void; onSettled?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const epoch = useRef(0);
  const active = useRef(false);
  useEffect(() => {
    epoch.current++;
    active.current = false;
    if (!enabled) { setBusy(false); setReady(false); setError(undefined); }
    return () => { epoch.current++; };
  }, [enabled]);
  useEffect(() => {
    onState?.(!enabled ? 'idle' : busy ? 'connecting' : ready ? 'connected' : error ? 'failed' : 'idle');
  }, [enabled, busy, ready, error, onState]);
  async function connect() {
    if (!enabled || paused || active.current || ready) return;
    active.current = true;
    const request = ++epoch.current;
    setBusy(true); setError(undefined);
    const result = await connectModel();
    if (request !== epoch.current) return;
    active.current = false; setBusy(false);
    if (result.ok) setReady(true);
    else setError(result.message);
    onSettled?.();
  }
  return <section className="card setup-model" aria-labelledby="model-title" aria-busy={busy}>
    <h2 id="model-title">{enabled ? 'Connect a model' : 'Model connection locked'}</h2>
    {!enabled ? <p className="muted">Start the local VM before connecting a model. No credentials are sent.</p>
      : <p className="muted">Use your existing GitHub CLI sign-in for Copilot in this VM. Bridge stores it in the native credential store and delivers it privately to the guest.</p>}
    <button type="button" className="setup-button" disabled={!enabled || paused || busy || ready} onClick={() => { void connect(); }}>
      {!enabled ? 'Connect model' : busy ? 'Connecting model…' : ready ? 'Model connected' : 'Use GitHub sign-in'}
    </button>
    {busy && <p role="status">Reading the sign-in, storing it and connecting the guest model…</p>}
    {ready && <><p role="status">Model connected: copilot / gpt-5.6-terra.</p>
      <p className="muted">The guest acknowledged Connect. This does not prove inference.</p></>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
