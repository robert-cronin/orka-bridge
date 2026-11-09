import { useEffect, useState } from 'react';
import { agentInfo } from '../designer/agent-api';
import { formatSize } from './requirements';
import { type ExamplePair, loadExample, type SetupStatus } from './state';
import Recovery from './Recovery';
import { modelDetails } from './recovery-info';
import './steps.css';

export type CheckStepState = 'running' | 'passed' | 'failed' | 'unknown' | 'stale';

function PhaseIcon({ phase }: { phase: 'done' | 'current' | 'waiting' | 'failed' }) {
  return <svg className={`icon step-icon step-${phase}`} viewBox="0 0 24 24" aria-hidden="true">
    {phase === 'done' ? <path d="m5 12 4 4L19 6" /> : phase === 'failed' ? <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>
      : <><circle cx="12" cy="12" r="9" /><path d={phase === 'current' ? 'M12 3v18' : 'M12 8v4l3 2'} /></>}
  </svg>;
}
export default function Steps({ status, busy, stopping, error, modelConnected, firstCheck, onCancel, onRestart, onChange, onOpenExample }: {
  status: SetupStatus; busy: boolean; stopping: boolean; error?: string; modelConnected: boolean; firstCheck?: CheckStepState;
  onCancel: () => void; onRestart: () => void; onChange: (button: HTMLButtonElement) => void; onOpenExample: () => void;
}) {
  const [details, setDetails] = useState(false);
  const ready = status.localVm === 'ready'; const failed = status.localVm === 'failed';
  const paused = status.localVm === 'cancelled' || status.localVm === 'closed';
  const progress = status.workspaceProgress;
  const copying = !stopping && status.localVm === 'installing' && progress?.phase === 'materializing';
  const numbers = copying && progress.bytes !== null && progress.totalBytes !== null;
  const remaining = copying ? progress.remainingMs : null;
  const eta = remaining != null && remaining > 0 ? `${Math.ceil(remaining / 1000)} seconds left` : undefined;
  const checkPhase = firstCheck === 'passed' ? 'done' : firstCheck === 'failed' ? 'failed' : firstCheck === 'running' || (modelConnected && !firstCheck) ? 'current' : 'waiting';
  const checkLabel = firstCheck ? { running: 'Running', passed: 'Passed', failed: 'Failed', unknown: 'Result unknown', stale: 'Needs running' }[firstCheck] : modelConnected ? 'Needs you' : 'Waiting';
  const phase = ready ? 'done' : failed ? 'failed' : paused || status.localVm === 'notIntegrated' ? 'waiting' : 'current';
  const stateLine = error ? 'Workspace status is unavailable.' : stopping ? 'Stopping your workspace…' : ready ? 'Your workspace is running on this computer.'
    : paused ? 'What has arrived is kept.' : status.localVm === 'starting' ? 'Starting your workspace…'
    : status.localVm === 'closing' ? 'Stopping your workspace…'
    : status.localVm === 'notIntegrated' ? 'Workspace setup is not included in this build. Nothing will be downloaded or started.'
    : copying ? 'Installing your workspace…' : 'Checking your workspace files…';
  return <section className="card workspace-steps" aria-label="Workspace setup">
    <ol className="steps-four" aria-label="Setup steps">
      <li className="step-done"><PhaseIcon phase="done" /><b>Where agents run</b><span className="step-result">On this computer</span></li>
      <li className={`step-${phase}`} aria-current={phase === 'current' ? 'step' : undefined}>
        <PhaseIcon phase={phase} /><b>Get your workspace ready</b><span className="step-result">{ready ? 'Ready' : paused ? 'Paused' : failed ? 'Needs attention' : eta}</span>
        <div className="step-more">
          {failed ? <Recovery key={status.localVmError} detail={status.localVmError} disabled={busy || !!error} onRetry={onRestart} /> : <p role="status">{stateLine}</p>}
          {!stopping && status.localVm === 'starting' && <><div className="workspace-indeterminate" role="progressbar" aria-label="Workspace startup" /><p className="muted">{progress?.phase === 'starting' ? `${Math.floor(progress.elapsedMs / 1000)} seconds elapsed` : 'Getting the workspace ready…'}</p></>}
          {numbers && <><progress aria-label="Workspace installation" value={progress.bytes!} max={progress.totalBytes!} />
            <p className="muted">Installing, {formatSize(progress.bytes!)} of {formatSize(progress.totalBytes!)}</p></>}
          {!failed && <><button type="button" className="workspace-disclosure" aria-expanded={details} aria-controls="workspace-progress-details" onClick={() => setDetails(value => !value)}>{details ? 'Hide details' : 'Show details'}</button>
          {details && <div id="workspace-progress-details" className="workspace-progress-details">
            <dl><div><dt>Checking workspace files</dt><dd>{status.localVm === 'preparing' || progress?.phase === 'verifying' ? 'In progress' : ready || copying || status.localVm === 'starting' ? 'Checked' : 'Waiting'}</dd></div>
              <div><dt>Installing workspace files</dt><dd>{ready || status.localVm === 'starting' ? 'Installed' : copying ? 'In progress' : 'Waiting'}</dd></div>
              <div><dt>Starting workspace</dt><dd>{ready ? 'Ready' : status.localVm === 'starting' ? 'In progress' : 'Waiting'}</dd></div></dl>
            {progress && <p className="muted">{Math.floor(progress.elapsedMs / 1000)} seconds in this file step.</p>}
            {status.localVmError && <pre tabIndex={0}>{ready ? modelDetails(status.localVmError) : status.localVmError}</pre>}
          </div>}</>}
        </div>
      </li>
      <li className={modelConnected ? 'step-done' : ready ? 'step-current' : 'step-waiting'}><PhaseIcon phase={modelConnected ? 'done' : ready ? 'current' : 'waiting'} /><b>Choose the AI your agent uses</b><span className="step-result">{modelConnected ? 'Connected' : ready ? 'Needs you' : 'Waiting'}</span></li>
      <li className={`step-${checkPhase}`}><PhaseIcon phase={checkPhase} /><b>Run your first test</b><span className="step-result">{checkLabel}</span></li>
    </ol>
    <div className="workspace-step-actions">
      {['preparing', 'installing', 'starting'].includes(status.localVm) && <><button type="button" className="workspace-secondary" disabled={busy || !!error} onClick={onCancel}>Cancel</button><span className="muted">Cancel keeps what has arrived.</span></>}
      {paused && <button type="button" className="workspace-primary" disabled={busy || !!error} onClick={onRestart}>Start again</button>}
      {ready && <><button type="button" className="workspace-secondary" disabled={busy || !!error} onClick={event => onChange(event.currentTarget)}>Change where agents run</button><button type="button" className="workspace-primary" disabled={!!error} onClick={onOpenExample}>Open example</button></>}
    </div>
  </section>;
}

export function Meet({ onRead, onName }: { onRead: () => void; onName?: (name: string | undefined) => void }) {
  const [pair, setPair] = useState<ExamplePair>();
  const [failed, setFailed] = useState(false);
  useEffect(() => { let mounted = true; void loadExample().then(result => { if (!mounted) return; if (result.ok) setPair(result.pair); else setFailed(true); }); return () => { mounted = false; }; }, []);
  const info = agentInfo(pair?.agent);
  useEffect(() => { if (pair) onName?.(info.name); }, [pair, info.name, onName]);
  const webReader = info.name === 'web-reader' && /name: web_fetch(?:\r?\n|$)/.test(pair?.agent ?? '');
  return <section className="card workspace-meet" aria-labelledby="meet-title">
    <span className="workspace-kicker">Meet your first agent</span><h2 id="meet-title">{info.name ?? 'Your first agent'}</h2>
    {pair ? <>{info.description && <p className="meet-description">{info.description}</p>}
      <dl>{webReader && <><div><dt>What it can do</dt><dd><span className="workspace-tool">Read a web page <code>web_fetch</code></span></dd></div>
        <div><dt>How we'll check it</dt><dd>We'll ask for a checksum published on a web page. The check looks for the exact value in the answer.</dd></div></>}
        <div><dt>Whose is it</dt><dd>Yours. After setup you can change its instructions, add checks, or start a new agent.</dd></div></dl>
      <button type="button" className="workspace-secondary" onClick={onRead}>Read its instructions</button></>
      : <p className="muted">{failed ? 'The example could not be opened. Try opening Designer.' : "Opening the example's introduction…"}</p>}
  </section>;
}
