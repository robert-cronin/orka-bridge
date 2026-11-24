// Development-only browser preview. It answers native commands with scripted
// replies so the real UI can be walked in a browser without a VM. main.tsx loads
// it only from `npm run dev` with a `?scenario=` query; release builds never
// include it.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import agentSource from '../../src-tauri/example-agent/web-reader.agent.md?raw';
import testSource from '../../src-tauri/example-agent/web-reader.agent.test.md?raw';
import { SAMPLE_DOCUMENT_ID } from '../designer/agent-api';

export const scenarios = {
  fresh: 'First run on a new computer',
  ready: 'Workspace ready, AI not connected',
  connected: 'Workspace ready, AI connected',
  restart: 'Reopened while the workspace starts',
  ghMissing: 'GitHub CLI not installed',
  ghSignedOut: 'GitHub CLI installed, signed out',
  runFails: 'Example test fails',
  vmFailed: 'Virtualization turned off',
} as const;
export type Scenario = keyof typeof scenarios;
type Gh = 'missing' | 'signedOut' | 'signedIn';

const GiB = 1024 ** 3;
const imageBytes = 3_334_537_216;
// Seconds per phase, shaped like a first run on a typical Windows computer.
const timing = { verify: 3, copy: 8, start: 90, reopen: 30 };
const runSeconds = 20;
const chatSeconds = 3;

const params = new URLSearchParams(location.search);
const requested = params.get('scenario') ?? 'fresh';
export const scenario: Scenario = requested in scenarios ? requested as Scenario : 'fresh';
const speed = Math.max(0.1, Number(params.get('speed')) || 1);
let gh: Gh = (['missing', 'signedOut', 'signedIn'] as const).find(value => value === params.get('gh'))
  ?? (scenario === 'ghMissing' ? 'missing' : scenario === 'ghSignedOut' ? 'signedOut' : 'signedIn');

const now = () => Date.now() * speed;
const fresh = scenario === 'fresh' || scenario === 'vmFailed' || scenario === 'ghMissing' || scenario === 'ghSignedOut';
let selected: 'localVm' | null = fresh ? null : 'localVm';
let startedAt: number | null = scenario === 'restart' ? now() : null;
let reopened = scenario === 'restart';
let stopped: 'cancelled' | 'closed' | null = null;
let modelConnected = scenario === 'connected' || scenario === 'runFails';

// Deterministic 64-hex digest; the preview only needs stable, distinct source ids.
function digest(text: string) {
  let h = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i) ^ round, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
const uuid = (seed: string) => { const d = digest(seed); return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`; };
const installation = uuid('installation');

type Doc = { name: string; agent: string; tests: string };
const docs = new Map<string, Doc>([[SAMPLE_DOCUMENT_ID, { name: 'web-reader', agent: agentSource, tests: testSource }]]);
let selectedDocument = SAMPLE_DOCUMENT_ID;
const source = (doc: Doc) => ({ agent: digest(doc.agent), tests: digest(doc.tests) });
const blankTests = (name: string) => `---\nschemaVersion: 1\n---\n\n# ${name} tests\n`;
function blankAgent(name: string, model = 'gpt-5.6-terra') {
  return `---\nname: ${name}\ndescription: ""\nmodel: ${model}\nkmx:\n  schemaVersion: 1\n  runtime: orka\n  tools: []\n---\n`;
}

type Phase = { localVm: 'idle' | 'preparing' | 'installing' | 'starting' | 'ready' | 'failed' | 'cancelled' | 'closed'; progress: object | null };
function phase(): Phase {
  if (!selected) return { localVm: 'idle', progress: null };
  if (stopped) return { localVm: stopped, progress: null };
  if (scenario === 'vmFailed') return { localVm: 'failed', progress: null };
  if (startedAt === null) return { localVm: 'ready', progress: null };
  const s = (now() - startedAt) / 1000;
  const ms = (value: number) => Math.max(0, Math.round(value * 1000 / speed));
  if (!reopened) {
    if (s < timing.verify) return { localVm: s < 1 ? 'preparing' : 'installing', progress: { phase: 'verifying', bytes: null, totalBytes: null, elapsedMs: ms(s), remainingMs: null } };
    const copied = s - timing.verify;
    if (copied < timing.copy) return { localVm: 'installing', progress: { phase: 'materializing', bytes: Math.round(imageBytes * copied / timing.copy), totalBytes: imageBytes, elapsedMs: ms(copied), remainingMs: ms(timing.copy - copied) } };
  }
  const booting = s - (reopened ? 0 : timing.verify + timing.copy);
  if (booting < (reopened ? timing.reopen : timing.start)) return { localVm: 'starting', progress: { phase: 'starting', bytes: null, totalBytes: null, elapsedMs: ms(booting), remainingMs: null } };
  startedAt = null; reopened = false;
  return { localVm: 'ready', progress: null };
}
const ready = () => phase().localVm === 'ready';

function status() {
  const p = phase();
  return {
    selected, localVm: p.localVm, localVmError: null, model: p.localVm === 'ready' ? 'available' : 'locked', modelSupported: true,
    workspaceProgress: p.progress,
    ...(p.localVm === 'failed' ? { preflightFailure: 'virtualizationDisabled' } : {}),
  };
}

let run: { documentId: string; startedAt: number; attemptId: string | null; count: number } | null = null;
let runCount = 0;
function runSnapshot(documentId: string) {
  const doc = docs.get(documentId);
  const canRun = ready() && modelConnected;
  const base = { documentId, busy: null, modelConnected, source: doc ? source(doc) : null, pending: null, error: null };
  if (!run || run.documentId !== documentId) return { ...base, attemptId: null, state: 'idle', stage: null, canRun, report: null, acknowledged: [] };
  const elapsed = (now() - run.startedAt) / 1000;
  const acknowledged = [{ kind: 'Agent', name: doc?.name ?? 'agent', uid: uuid(`agent${run.count}`) }, { kind: 'Task', name: `${doc?.name ?? 'agent'}-test-${run.count}`, uid: uuid(`task${run.count}`) }];
  if (elapsed < runSeconds) return { ...base, attemptId: run.attemptId, busy: { documentId, name: doc?.name ?? 'agent' }, state: 'running', stage: 'observe', canRun: false, report: null, acknowledged };
  const pass = scenario !== 'runFails';
  const checksum = 'cf699c56340dc775230fde4ef84237d27563ea6ef52164c7d078072b586c3918';
  return { ...base, attemptId: run.attemptId, state: 'complete', stage: 'done', canRun, acknowledged, report: { verdict: pass ? 'passed' : 'failed', cases: [{
    id: 'published-checksum', title: 'Published checksum', phase: 'Succeeded',
    question: 'Open the download page and report the SHA-256 checksum it publishes.',
    answer: pass ? `The page publishes this SHA-256 checksum:\n\n${checksum}` : "I couldn't fetch that page, so I can't tell you the checksum.",
    completedTools: pass ? ['web_fetch'] : [],
    assertions: [
      { id: 'checksum-from-page', kind: 'contains', expected: checksum, verdict: pass ? 'passed' : 'failed' },
      { id: 'fetched-page', kind: 'toolCalled', expected: 'web_fetch', verdict: pass ? 'passed' : 'failed' },
    ],
    verdict: pass ? 'passed' : 'failed',
  }] } };
}

type Turn = { message: string; answer: string | null; phase: string; tools: { name: string; callId: string; phase: string }[]; contextRetained: boolean; terminationUnconfirmed: boolean; stopUnconfirmed: boolean; sentAt: number };
const chats = new Map<string, Turn[]>();
function chatSnapshot(documentId: string) {
  const turns = chats.get(documentId) ?? [];
  for (const turn of turns) {
    if (turn.answer === null && (now() - turn.sentAt) / 1000 >= chatSeconds) { turn.answer = reply(documentId, turn.message, turns); turn.phase = 'Succeeded'; }
  }
  const working = turns.some(turn => turn.answer === null);
  const canSend = ready() && modelConnected && !working;
  return {
    documentId, state: working ? 'working' : 'ready', busy: working, canSend, error: null,
    versions: [{ turns: turns.map(turn => ({ message: turn.message, answer: turn.answer, phase: turn.phase, tools: turn.tools, contextRetained: turn.answer !== null, terminationUnconfirmed: false, stopUnconfirmed: false })) }],
  };
}
function reply(documentId: string, message: string, turns: Turn[]) {
  const doc = docs.get(documentId);
  if (doc?.name === 'web-reader') {
    const url = /https?:\/\/\S+/.exec(message)?.[0]?.replace(/[.,)]+$/, '');
    return url ? `I read ${url}.\n\n- It is a placeholder page kept for documentation examples.\n- It has one heading and one paragraph.\n- It links to an explanation of why the domain is reserved.`
      : 'Send me a link and I will read the page and tell you what it says.';
  }
  if (doc?.name === 'bridge-assistant') {
    return 'Hi, I’m Bridge. This preview answers with scripted text; in the desktop app I answer with the AI in your workspace and can search the web and read pages for you.\n\n- Ask me a question, or for help with a small job.\n- For a job you repeat, make your own agent in Designer.';
  }
  return `This preview answers with scripted text. In the desktop app, ${doc?.name ?? 'your agent'} answers with the AI in your workspace.${turns.length > 1 ? `\n\nThis conversation has ${turns.length} messages so far.` : ''}`;
}

function savedFiles() {
  return {
    state: 'complete', runActive: !!run && (now() - run.startedAt) / 1000 < runSeconds, historyState: 'complete', runAgents: [],
    files: [...docs].map(([documentId, doc]) => {
      const description = /^description: (.+)$/m.exec(doc.agent)?.[1]?.replace(/^"|"$/g, '') || null;
      const model = /^model: (.+)$/m.exec(doc.agent)?.[1] ?? 'gpt-5.6-terra';
      return { documentId, name: doc.name, state: 'readable', source: source(doc), summary: { name: doc.name, description, model, tools: doc.name === 'web-reader' ? ['web_fetch'] : [] }, reason: null, localResult: null };
    }),
  };
}

const wait = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000 / speed));
function pair(documentId: string) {
  const doc = docs.get(documentId);
  if (!doc) throw 'Your agent folder could not be opened.';
  return { documentId, name: doc.name, agent: doc.agent, tests: doc.tests, source: source(doc), path: `C:\\Users\\you\\Orka\\agents\\${doc.name}`, storage: 'bridge' };
}
const documentId = (args?: Record<string, unknown>) => typeof args?.documentId === 'string' ? args.documentId : SAMPLE_DOCUMENT_ID;
const upgradeNone = { state: 'none', transaction: null, createdAt: null, sourceReleases: [], targetRelease: null, retainedAllocatedBytes: null, additionalBytes: null, credential: 'absent', busy: false, error: null, repeated: false, canReplace: false, canRestore: false, canCancel: false };

async function handle(command: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case 'setup_requirements': return { memoryBytes: 6 * GiB, imageBytes, stateDiskBytes: 32 * GiB, downloadBytes: null };
    case 'setup_preflight': return { platform: 'windows', virtualization: scenario === 'vmFailed' ? 'disabled' : 'ready', memory: 'ready', installedMemoryBytes: 32 * GiB, requiredMemoryBytes: 6 * GiB };
    case 'setup_status': return status();
    case 'setup_select_local':
      await wait(0.3);
      if (!selected || stopped) { selected = 'localVm'; stopped = null; startedAt = now(); }
      return status();
    case 'setup_cancel_local': stopped = 'cancelled'; startedAt = null; return status();
    case 'setup_change_local': await wait(1); selected = null; stopped = null; startedAt = null; modelConnected = false; return status();
    case 'setup_example': return { agent: agentSource, tests: testSource };
    case 'setup_open_help': return null;
    case 'setup_connect_model':
      await wait(2);
      if (!ready()) throw { kind: 'modelGuest' };
      if (gh === 'missing') throw { kind: 'modelCaptureUnavailable' };
      if (gh === 'signedOut') throw { kind: 'modelCaptureFailed' };
      modelConnected = true;
      return { ready: true, connection: { kind: 'copilot', model: 'gpt-5.6-terra', account: 'octocat' } };
    case 'setup_remove_model': case 'setup_reset_model': await wait(1); modelConnected = false; return { ready: false };
    case 'workspace_upgrade_status': return upgradeNone;
    case 'workspace_catalog':
      if (!ready() || !modelConnected) throw 'catalogUnavailable';
      return {
        defaultModel: 'gpt-5.6-terra',
        models: { state: 'ready', items: [{ id: 'gpt-5.6-terra', pickerEnabled: true, chatSupported: true }, { id: 'claude-sonnet-5-5', pickerEnabled: true, chatSupported: true }] },
        tools: { state: 'ready', items: [{ kind: 'builtin', name: 'web_fetch', description: 'Fetch a web page and return its text.' }, { kind: 'builtin', name: 'web_search', description: 'Search the web.' }] },
      };
    case 'agents_list': return [...docs].map(([id, doc]) => ({ id, name: doc.name, path: pair(id).path, available: true }));
    case 'agent_selected': return selectedDocument;
    case 'agent_select': selectedDocument = documentId(args); return null;
    case 'agent_creation_root': return 'C:\\Users\\you\\Orka\\agents';
    case 'agent_pick_repo': return null;
    case 'agent_create': {
      const name = String(args?.name ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || [...docs.values()].some(doc => doc.name === name)) throw 'invalid';
      const id = uuid(`doc-${name}`);
      docs.set(id, { name, agent: blankAgent(name, typeof args?.model === 'string' ? args.model : undefined), tests: blankTests(name) });
      return id;
    }
    case 'agent_open': return pair(documentId(args));
    case 'agent_save': {
      const id = documentId(args);
      await wait(0.2);
      const doc = docs.get(id);
      if (!doc) throw 'missing';
      doc.agent = String(args?.content ?? doc.agent);
      return pair(id);
    }
    case 'agent_reveal': return null;
    case 'agent_run_status': return runSnapshot(documentId(args));
    case 'agent_run': {
      const id = documentId(args);
      if (!runSnapshot(id).canRun) return runSnapshot(id);
      run = { documentId: id, startedAt: now(), attemptId: typeof args?.attemptId === 'string' ? args.attemptId : null, count: ++runCount };
      return runSnapshot(id);
    }
    case 'agent_run_cancel': case 'agent_run_check_cancellation': return runSnapshot(documentId(args));
    case 'agent_chat_status': case 'agent_chat_reconnect': case 'agent_chat_start': return chatSnapshot(documentId(args));
    case 'agent_chat_new': chats.set(documentId(args), []); return chatSnapshot(documentId(args));
    case 'agent_chat_stop': return chatSnapshot(documentId(args));
    case 'agent_chat_send': {
      const id = documentId(args);
      if (!chatSnapshot(id).canSend) throw 'busy';
      const turns = chats.get(id) ?? [];
      turns.push({ message: String(args?.message ?? ''), answer: null, phase: 'Running', tools: [], contextRetained: turns.length > 0, terminationUnconfirmed: false, stopUnconfirmed: false, sentAt: now() });
      chats.set(id, turns);
      return chatSnapshot(id);
    }
    case 'overview_files': return savedFiles();
    case 'overview_agents': return ready()
      ? { state: 'complete', installation, agents: [], observedAt: Math.floor(Date.now() / 1000), observation: null, runActive: false, reason: null }
      : { state: 'unavailable', installation: null, agents: [], observedAt: null, observation: null, runActive: false, reason: 'stopped' };
    case 'overview_places': return { places: [], historyState: 'complete', unobserved: [] };
    case 'cluster_places': return { places: [], selectedKey: null, persistenceState: 'complete' };
    case 'cluster_contexts': case 'cluster_reload': return [];
    case 'send_history': return [];
    case 'send_status': return null;
    case 'quit_bridge': document.body.textContent = 'Bridge quit.'; return null;
    default:
      if (command.startsWith('plugin:window|')) return command === 'plugin:window|is_maximized' ? false : null;
      throw `preview: ${command} is not scripted`;
  }
}

function toolbar() {
  const bar = document.createElement('form');
  bar.className = 'preview-toolbar';
  bar.setAttribute('aria-label', 'Preview controls');
  const select = (name: string, value: string, options: Record<string, string>) =>
    `<label>${name}<select name="${name}">${Object.entries(options).map(([key, label]) => `<option value="${key}"${key === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
  bar.innerHTML = `<b>Preview</b>${select('scenario', scenario, scenarios)}${select('speed', String(speed), { 1: '1×', 5: '5×', 20: '20×', 100: '100×' })}${select('gh', gh, { signedIn: 'signed in', signedOut: 'signed out', missing: 'not installed' })}<button type="submit">Restart</button>`;
  bar.querySelector<HTMLSelectElement>('select[name=gh]')!.addEventListener('change', event => { gh = (event.target as HTMLSelectElement).value as Gh; });
  bar.addEventListener('submit', event => {
    event.preventDefault();
    const next = new URLSearchParams(location.search);
    for (const key of ['scenario', 'speed']) next.set(key, (bar.elements.namedItem(key) as HTMLSelectElement).value);
    location.search = next.toString();
  });
  const style = document.createElement('style');
  style.textContent = '.preview-toolbar{position:fixed;right:8px;bottom:8px;z-index:9999;display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:8px;background:#2b2140;color:#e9e3ff;font:12px system-ui;opacity:.35;transition:opacity .15s}.preview-toolbar:hover,.preview-toolbar:focus-within{opacity:1}.preview-toolbar select,.preview-toolbar button{margin-left:4px;font:inherit}';
  document.head.append(style);
  document.body.append(bar);
}

export function installPreview() {
  try {
    // Each load starts from the scenario, not from the previous walk's browser storage.
    for (const key of Object.keys(localStorage)) if (key.startsWith('bridge.')) localStorage.removeItem(key);
    if (!fresh) localStorage.setItem('bridge.welcomeSeen.v1', '1');
    if (!fresh) localStorage.setItem('bridge.firstTest.v1', 'attempted');
  } catch { /* Storage is optional in the preview. */ }
  (globalThis as { isTauri?: boolean }).isTauri = true;
  mockWindows('main');
  mockIPC((command, args) => handle(command, args as Record<string, unknown> | undefined));
  if (!params.has('clean')) toolbar();
}
