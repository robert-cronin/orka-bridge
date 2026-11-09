import { useEffect, useRef, useState } from 'react';
import { errors, runCall, type RunSnapshot } from './run-api';
import { sameSource, type SourceId } from './agent-api';
export default function Run({ onSnapshot, blocked = false, stale = false, onStart, source }: { onSnapshot?: (snapshot: RunSnapshot | undefined) => void; blocked?: boolean; stale?: boolean; onStart?: () => void; source?: SourceId }) {
  const [snapshot, setSnapshot] = useState<RunSnapshot>();
  const [message, setMessage] = useState<string>();
  const [sending, setSending] = useState(false);
  const active = useRef(false);
  const sourceCurrent = sameSource(source, snapshot?.source);
  useEffect(() => {
    active.current = true;
    const observe = async () => {
      const result = await runCall('setup_run_status');
      if (!active.current) return;
      if (result.ok) { setSnapshot(result.snapshot); setMessage(undefined); } else setMessage(result.message);
    };
    void observe(); const timer = window.setInterval(() => { void observe(); }, 500);
    return () => { active.current = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { if (snapshot || message) onSnapshot?.(message ? undefined : snapshot ? { ...snapshot, sourceCurrent } : undefined); }, [snapshot, message, onSnapshot, sourceCurrent]);
  const start = async () => {
    if (sending || blocked || !snapshot?.canRun) return;
    setSending(true);
    const result = await runCall('setup_run_example');
    if (!active.current) return;
    if (result.ok) { onStart?.(); setSnapshot(result.snapshot); setMessage(undefined); } else setMessage(result.message);
    setSending(false);
  };
  const running = sending || snapshot?.state === 'running';
  const outdated = stale || (sourceCurrent === false && !!snapshot?.report);
  return <div className="example-run" aria-labelledby="run-title">
    <h3 id="run-title">Test on the local VM</h3>
    <p className="muted">Run creates an Orka Agent and Task from these exact files.{snapshot?.modelConnected === false && ' Connect the model in Clusters first.'}</p>
    <button type="button" className="setup-button" disabled={blocked || running || !snapshot?.canRun} title={blocked ? 'Save your changes before running the check' : running ? 'Check is running' : !snapshot?.canRun ? 'Connect your workspace and AI in Clusters first' : undefined} onClick={() => { void start(); }}>Run test</button>
    {outdated && <p role="status">Not run since your change. Any result below is from the earlier file.</p>}
    {running && <p role="status">Running on the local VM…</p>}
    {message && <p role="status">{message}</p>}
    {snapshot?.error && !(snapshot.error === 'model' && snapshot.modelConnected) && <p role="alert">{errors[snapshot.error]}</p>}
    {snapshot?.pending && <p>Possibly created {snapshot.pending.kind}: {snapshot.pending.name}</p>}
    {snapshot?.report && <>
      <p role="status">{outdated ? 'Earlier test verdict' : 'Test verdict'}: {snapshot.report.verdict}</p>
      {snapshot.report.cases.map(c => <div key={c.id}>
        <h4>{c.id}</h4>
        <p>Task: {c.phase}</p>
        <h4>Answer</h4>
        {c.answer !== null ? <pre className="example-source" tabIndex={0}>{c.answer}</pre> : <p>No answer was observed.</p>}
        <h4>Completed tool calls</h4>
        {c.completedTools.length ? <ul>{c.completedTools.map(tool => <li key={tool}>{tool}</li>)}</ul> : <p>No completed tool calls were observed. Missing evidence is unknown.</p>}
        <h4>Assertions</h4>
        <ul>{c.assertions.map(a => <li key={a.id}><span>{a.kind}: {a.verdict}</span> <span className="muted">({a.id})</span></li>)}</ul>
      </div>)}
    </>}
    {!!snapshot?.acknowledged.length && <details><summary>Acknowledged resources</summary><ul>{snapshot.acknowledged.map(r => <li key={r.uid}>{r.kind}: {r.name}</li>)}</ul></details>}
  </div>;
}
