import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { loadExample, type ExamplePair } from '../setup/state';
import { agentCall, agentInfo, type AgentPair, type SaveState } from './agent-api';
import Run from './Run';
import AgentParts from './AgentParts';
import { readForm } from './agent-form';
import type { RunSnapshot } from './run-api';

export default function Example({ active = true, readOnly = false, actions, onPair, onRun, onSaveState, onStale }: {
  active?: boolean; readOnly?: boolean; actions?: ReactNode;
  onPair?: (pair: ExamplePair | undefined) => void; onRun?: (snapshot: RunSnapshot | undefined) => void;
  onSaveState?: (state: SaveState) => void; onStale?: (stale: boolean) => void;
}) {
  const [pair, setPair] = useState<AgentPair>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [view, setView] = useState<'Agent' | 'File'>('Agent');
  const [stale, setStale] = useState(false);
  const latest = useRef(''); const saved = useRef(''); const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lineEnding = useRef('\n'); const needsCommit = useRef(false);
  useEffect(() => {
    let mounted = true;
    const open = readOnly ? loadExample().then(result => { if (!result.ok) throw Error(result.message); return result.pair; }) : agentCall('agent_open');
    void open.then(value => {
      if (!mounted) return;
      setPair(value); setDraft(value.agent); latest.current = saved.current = value.agent;
      lineEnding.current = value.agent.includes('\r\n') ? '\r\n' : '\n'; onPair?.(value);
    }, () => { if (mounted) { setError('Your agent folder could not be opened. Open it again from Designer.'); onPair?.(undefined); } });
    return () => { mounted = false; };
  }, [onPair, readOnly]);
  useEffect(() => { onSaveState?.(saveState); }, [saveState, onSaveState]);
  useEffect(() => { onStale?.(stale); }, [stale, onStale]);

  const flush = useCallback(async (retry = false) => {
    clearTimeout(timer.current);
    if (readOnly || busy.current) return;
    if (!retry && !needsCommit.current && latest.current === saved.current) { setSaveState('saved'); return; }
    busy.current = true; setSaveState('saving'); setError(undefined);
    try {
      do {
        const content = latest.current;
        const value = await agentCall('agent_save', content);
        if (value.agent !== content) throw Error('Save did not confirm the current file.');
        saved.current = content; setPair(value); onPair?.(value);
        // Fingerprinted replies let Run distinguish older results from unsaved edits.
        if (value.source) setStale(latest.current !== content);
      } while (latest.current !== saved.current);
      needsCommit.current = false; setSaveState('saved');
    } catch { needsCommit.current = true; setSaveState('error'); setError('Your changes could not be saved. Your draft is still here.'); }
    finally { busy.current = false; }
  }, [onPair, readOnly]);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const edit = (value: string, rawFile = false) => {
    if (readOnly) return;
    const content = rawFile ? value.replace(/\r\n/g, '\n').replaceAll('\n', lineEnding.current) : value;
    if (content === latest.current) return;
    latest.current = content; setDraft(content); setStale(!pair?.source || content !== saved.current); setError(undefined);
    setSaveState('dirty'); clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 500);
  };
  const info = { ...agentInfo(draft), description: readForm(draft).description };
  const saveLabel = { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Not saved' }[saveState];
  return <section className="designer" aria-labelledby={active ? 'page-title' : undefined}>
    <div className="page-heading designer-heading">
      <div className="agent-heading-copy"><h1 id={active ? 'page-title' : undefined}>{info.name ?? (pair ? 'Agent file' : 'Designer')}</h1>{info.description && <p className="muted">{info.description}</p>}</div>
      <div className="heading-actions">
        <div className="view-switch" role="group" aria-label="Designer view">
          <button type="button" aria-pressed={view === 'Agent'} onClick={() => setView('Agent')}>Agent</button>
          <span className="coming-control" tabIndex={0} role="group" aria-label="Chat: Chat is coming" title="Chat is coming"><button type="button" disabled title="Chat is coming">Chat</button><span className="control-tip" aria-hidden="true">Chat is coming</span></span>
          <button type="button" aria-pressed={view === 'File'} disabled={!pair} title={!pair ? 'Wait for your agent folder to open' : undefined} onClick={() => setView('File')}>File</button>
        </div>
        {actions}
      </div>
    </div>
    {!pair ? error ? <p role="alert">{error}</p> : <p role="status">Opening your agent…</p> : <>
      <div className="designer-file card">
        <div className="file-toolbar"><h2>{view === 'File' ? 'web-reader.agent.md' : 'Instructions and settings'}</h2><span className="muted" role="status">{readOnly ? 'Read-only during setup' : saveLabel}</span></div>
        {view === 'File' ? <>
          <label className="sr-only" htmlFor="agent-file">Agent file</label>
          <p className="muted" id="file-hint">{readOnly ? 'You can read the example while your workspace gets ready. Editing opens after setup.' : 'Changes save automatically in your agent’s folder. Each save is kept in its Git history.'}</p>
          <textarea readOnly={readOnly} id="agent-file" aria-describedby="file-hint" className="agent-editor" spellCheck={false} value={draft} onChange={event => edit(event.target.value, true)} onBlur={() => { void flush(); }} onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flush(); }
          }} />
        </> : <AgentParts source={draft} path={pair.path} readOnly={readOnly} onChange={edit} />}
        {error && <div className="save-error"><p role="alert">{error}</p><button className="setup-button" type="button" onClick={() => { void flush(true); }}>Try saving again</button></div>}
      </div>
      <div className="designer-checks card">
        {readOnly ? <div><h3>Checks</h3><span className="coming-control" tabIndex={0} role="group" aria-label="Run test: Wait for your workspace and AI to be ready" title="Wait for your workspace and AI to be ready"><button type="button" className="setup-button" disabled title="Wait for your workspace and AI to be ready">Run test</button><span className="control-tip" aria-hidden="true">Wait for your workspace and AI to be ready</span></span><p className="muted">Your workspace is getting ready. Connect the AI in Clusters before running a check.</p></div>
          : <Run source={pair.source} onSnapshot={onRun} blocked={saveState !== 'saved'} stale={stale} onStart={() => { if (latest.current === draft) setStale(false); }} />}
        <details className="check-source"><summary>Check file: web-reader.agent.test.md</summary><pre className="example-source" tabIndex={0} aria-label="Check file, read-only">{pair.tests}</pre></details>
      </div>
    </>}
  </section>;
}
