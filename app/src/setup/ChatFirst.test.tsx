import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../App';
import { assistantName } from '../home/assistant';
import { chatFirstPreference } from './chat-first';
import { firstTestPreference } from './first-test';
import { openLocalSetup } from './test-navigation';
import { noUpgrade } from './test-upgrade';

const requirements = { memoryBytes: 6442450944, imageBytes: 3651994962, stateDiskBytes: 34359738368, freeDiskBytes: 64424509440, downloadBytes: 2800000000 };
const assistantId = '3b2b93c4-375c-4815-9717-39852a96e414';
const seed = '---\nname: "bridge-assistant"\nmodel: "gpt-5.6-terra"\nkmx:\n  schemaVersion: 1\n  runtime: orka\n---\n\n';
const source = { agent: 'a'.repeat(64), tests: 'b'.repeat(64) };
type Status = { selected: string | null; localVm: string; model: string };

function native(initial: Status, { assistant = false } = {}) {
  vi.stubGlobal('isTauri', true);
  let status = initial;
  let agents = assistant ? [{ id: assistantId, name: assistantName, path: null, available: true }] : [];
  let content = seed;
  const ipc = vi.fn((command: string, args?: unknown) => {
    const documentId = (args as { documentId?: string } | undefined)?.documentId ?? assistantId;
    if (command === 'workspace_upgrade_status') return noUpgrade;
    if (command === 'setup_status') return status;
    if (command === 'setup_requirements') return requirements;
    if (command === 'setup_select_local') { status = { selected: 'localVm', localVm: 'starting', model: 'locked' }; return status; }
    if (command === 'setup_connect_model') return { ready: true };
    if (command === 'agents_list') return agents;
    if (command === 'agent_selected') return null;
    if (command === 'workspace_catalog') return { defaultModel: 'gpt-5.6-terra', models: { state: 'ready', items: [{ id: 'gpt-5.6-terra' }] }, tools: { state: 'ready', items: [{ kind: 'builtin', name: 'web_fetch', description: 'Read a page' }] } };
    if (command === 'agent_create') { agents = [{ id: assistantId, name: assistantName, path: null, available: true }]; return assistantId; }
    if (command === 'agent_open') return { documentId, name: assistantName, agent: content, tests: 'Checks', source };
    if (command === 'agent_save') { content = (args as { content: string }).content; return { documentId, name: assistantName, agent: content, tests: 'Checks', source }; }
    if (command === 'agent_run_status') return { documentId, busy: null, state: 'idle', canRun: true, modelConnected: true, report: null, acknowledged: [], pending: null, error: null };
    if (command === 'agent_chat_status') return { documentId, state: 'ready', busy: false, canSend: true, versions: [{ turns: [] }], error: null };
    return { kind: 'version', version: 'v0.4.2', hasDiagnostics: false };
  });
  mockIPC(ipc);
  return { ipc, ready: () => { status = { selected: 'localVm', localVm: 'ready', model: 'available' }; } };
}
// A returning workspace opens on Places; the row leads to local setup, where Connect is the AI step's action.
async function connect(user: ReturnType<typeof userEvent.setup>) {
  await openLocalSetup(user);
  await user.click(await screen.findByRole('button', { name: 'Connect the AI' }, { timeout: 2000 }));
}
const created = (ipc: ReturnType<typeof vi.fn>) => ipc.mock.calls.filter(([command]) => command === 'agent_create');

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

test('Set up Bridge starts this computer in one click and replaces the example test with a chat', async () => {
  const { ipc } = native({ selected: null, localVm: 'idle', model: 'locked' });
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Set up Bridge' }));
  expect(await screen.findByText('Starting the workspace…')).toBeTruthy();
  expect(ipc.mock.calls.filter(([command]) => command === 'setup_select_local')).toHaveLength(1);
  expect(localStorage.getItem(chatFirstPreference)).toBe('pending');
  expect(localStorage.getItem(firstTestPreference)).toBeNull();
  const steps = screen.getByRole('list', { name: 'Setup steps' });
  expect(within(steps).getAllByRole('listitem').map(row => row.querySelector('b')?.textContent).at(-1)).toBe('Chat with Bridge');
  expect(screen.getByRole('heading', { name: 'Meet Bridge' })).toBeTruthy();
  expect(created(ipc)).toHaveLength(0);
});

test('once the AI connects, chat-first setup creates Bridge\'s assistant and opens it on Home, once', async () => {
  localStorage.setItem('bridge.welcomeSeen.v1', '1'); localStorage.setItem(chatFirstPreference, 'pending');
  const { ipc } = native({ selected: 'localVm', localVm: 'ready', model: 'available' });
  const user = userEvent.setup(); const view = render(<App />);
  await connect(user);
  expect(await screen.findByRole('heading', { name: 'What can Bridge do for you?' })).toBeTruthy();
  const picker = await screen.findByRole('combobox', { name: 'Ask' });
  expect((picker as HTMLSelectElement).selectedOptions[0].textContent).toBe('Bridge');
  expect(created(ipc)).toHaveLength(1);
  expect(localStorage.getItem(chatFirstPreference)).toBe('done');
  view.unmount(); render(<App />);
  await connect(user);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(screen.queryByRole('heading', { name: 'What can Bridge do for you?' })).toBeNull();
  expect(created(ipc)).toHaveLength(1);
});

test('without chat-first setup, connecting the AI neither opens Home nor writes an agent', async () => {
  localStorage.setItem('bridge.welcomeSeen.v1', '1');
  const { ipc } = native({ selected: 'localVm', localVm: 'ready', model: 'available' });
  const user = userEvent.setup(); render(<App />);
  await connect(user);
  await waitFor(() => expect(ipc.mock.calls.some(([command]) => command === 'setup_connect_model')).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(screen.queryByRole('heading', { name: 'What can Bridge do for you?' })).toBeNull();
  expect(created(ipc)).toHaveLength(0);
});

test('Home offers Bridge\'s assistant but creates it only when asked', async () => {
  localStorage.setItem('bridge.welcomeSeen.v1', '1');
  const { ipc } = native({ selected: 'localVm', localVm: 'ready', model: 'available' });
  const user = userEvent.setup(); render(<App />);
  await connect(user);
  await waitFor(() => expect(ipc.mock.calls.some(([command]) => command === 'setup_connect_model')).toBe(true));
  await user.click(screen.getByRole('button', { name: 'Home' }));
  const add = await screen.findByRole('button', { name: 'Chat with Bridge' });
  expect(created(ipc)).toHaveLength(0);
  await user.click(add);
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Ask' }) as HTMLSelectElement).selectedOptions[0].textContent).toBe('Bridge'));
  expect(created(ipc)).toHaveLength(1);
});

test('after chat-first setup, a relaunch opens the returning workspace, not the first-setup steps', async () => {
  localStorage.setItem('bridge.welcomeSeen.v1', '1'); localStorage.setItem(chatFirstPreference, 'done');
  native({ selected: 'localVm', localVm: 'ready', model: 'available' }, { assistant: true });
  render(<App />); await openLocalSetup();
  expect(await screen.findByRole('region', { name: 'Workspace' })).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Setup steps' })).toBeNull();
});
