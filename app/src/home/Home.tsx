import { useEffect, useState } from 'react';
import mark from '../assets/orka-mark.svg';
import { Button } from '../components/Button';
import { SAMPLE_DOCUMENT_ID } from '../designer/agent-api';
import Chat from '../designer/Chat';
import { type AgentEntry, listDocuments } from '../designer/documents-api';
import { type AssistantFailure, assistantLabel, assistantName } from './assistant';
import { type HomeAction, homeNext } from './next';
import './home.css';

// Home is a place to give one of your agents a job. Each agent keeps one conversation, shared with
// its Chat view in Designer, and it runs in the workspace on this computer.
// Bridge's built-in assistant is the default; it is created on request, never just by opening Home.
export default function Home({ active, revision, preferred, assistantError, assistantBusy = false, blocked: placeBlocked, blockedFor, onAddAssistant, onOpenAgent, onChooseWorkspace }: {
  active: boolean; revision: number; preferred?: string; assistantError?: AssistantFailure; assistantBusy?: boolean; blocked?: string; blockedFor?: (documentId: string) => string | undefined;
  onAddAssistant?: () => void; onOpenAgent: (documentId: string) => void; onChooseWorkspace: () => void;
}) {
  // null means the list could not be read, which is different from having no agents.
  const [agents, setAgents] = useState<AgentEntry[] | null>();
  const [documentId, setDocumentId] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void listDocuments().then(list => { if (live) setAgents(list ? list.filter(agent => agent.available) : null); });
    return () => { live = false; };
  }, [active, revision, attempt]);
  const assistant = agents?.find(agent => agent.name === assistantName);
  const chosen = agents?.find(agent => agent.id === documentId) ?? agents?.find(agent => agent.id === preferred) ?? assistant
    ?? agents?.find(agent => agent.id === SAMPLE_DOCUMENT_ID) ?? agents?.[0];
  const agentBlocked = chosen ? blockedFor?.(chosen.id) : undefined;
  const blocked = placeBlocked ?? agentBlocked;
  const label = (agent: AgentEntry) => agent.name === assistantName ? assistantLabel : agent.name;
  const next = agents === undefined ? undefined : homeNext({
    listFailed: agents === null, assistantBusy, assistantError, placeBlocked, agentBlocked,
    chosen: chosen && { label: label(chosen) }, hasAssistant: !!assistant, canAddAssistant: !!onAddAssistant && !placeBlocked,
  });
  const act: Record<HomeAction, { text: string; run: () => void }> = {
    retryList: { text: 'Try again', run: () => { setAgents(undefined); setAttempt(value => value + 1); } },
    // Adding the assistant also selects it, so the person sees what they asked for.
    assistant: { text: !chosen ? 'Chat with Bridge' : assistantError ? 'Try again' : 'Add Bridge’s assistant', run: () => { setDocumentId(undefined); onAddAssistant?.(); } },
    clusters: { text: 'Open Clusters', run: onChooseWorkspace },
    designer: { text: 'Open in Designer', run: () => { if (chosen) onOpenAgent(chosen.id); } },
  };
  return <section className="home" aria-labelledby="page-title">
    <div className="home-hero">
      <img className="home-mark" src={mark} width="44" height="44" alt="" />
      <h1 id="page-title">What can Bridge do for you?</h1>
      <p className="muted">Ask Bridge, or give one of your agents a job. Answers come from your workspace on this computer.</p>
    </div>
    {agents === undefined && <p className="muted" role="status">Reading your agents…</p>}
    {next && <section className={`home-next tone-${next.tone}`} aria-labelledby="home-next-title">
      <p className="home-next-kicker" id="home-next-title">Next</p>
      <p className="home-next-line" role={next.tone === 'error' ? 'alert' : 'status'}>{next.line}</p>
      {next.action && <Button type="button" kind={next.action === 'assistant' && !chosen ? 'primary' : 'secondary'} disabled={assistantBusy} onClick={act[next.action].run}>{act[next.action].text}</Button>}
    </section>}
    {agents && chosen && <>
      <div className="home-agent">
        <label htmlFor="home-agent">Ask</label>
        <select id="home-agent" className="field" value={chosen.id} onChange={event => setDocumentId(event.target.value)}>
          {agents.map(agent => <option key={agent.id} value={agent.id}>{label(agent)}</option>)}
        </select>
        {next?.action !== 'designer' && <Button type="button" kind="quiet" onClick={() => onOpenAgent(chosen.id)}>Open in Designer</Button>}
      </div>
      {active && <Chat key={chosen.id} documentId={chosen.id} blocked={blocked} active={active} />}
    </>}
  </section>;
}
