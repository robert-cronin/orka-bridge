import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../App';

const pair = { agent: '---\nname: web-reader\ndescription: Answers from the web page named in the request\nkmx:\n  tools:\n    - kind: builtin\n      name: web_fetch\n---\nFetch before answering.', tests: 'The checksum check.' };
const progress = { phase: 'materializing', bytes: 1200000000, totalBytes: 3000000000, elapsedMs: 20000, remainingMs: 30000 };
function native(initial = 'installing', numbers: { phase: string; bytes: number | null; totalBytes: number | null; elapsedMs: number; remainingMs: number | null } | null = progress) {
  vi.stubGlobal('isTauri', true);
  let localVm = initial; let selected: 'localVm' | null = 'localVm'; let unavailable = false;
  const status = () => ({ selected, localVm, model: localVm === 'ready' ? 'available' : 'locked', workspaceProgress: ['installing', 'starting'].includes(localVm) ? numbers : null, localVmError: localVm === 'failed' ? 'PRIVATE_NATIVE_DETAIL' : null });
  const ipc = vi.fn((command: string) => {
    if (command === 'setup_status') { if (unavailable) throw Error('unreadable'); return status(); }
    if (command === 'setup_cancel_local') { localVm = 'cancelled'; return status(); }
    if (command === 'setup_select_local') { selected = 'localVm'; localVm = 'installing'; return status(); }
    if (command === 'setup_change_local') { localVm = 'idle'; selected = null; return status(); }
    if (command === 'setup_example' || command === 'agent_open') return pair;
    if (command === 'setup_connect_model') return { ready: true };
    if (command === 'setup_run_status') return { state: 'idle', canRun: true, report: null, acknowledged: [], pending: null, error: null };
    throw new Error('Unexpected command: ' + command);
  }); mockIPC(ipc);
  return { ipc, ready: () => { localVm = 'ready'; }, fail: () => { localVm = 'failed'; }, unreadable: () => { unavailable = true; } };
}
beforeEach(() => localStorage.setItem('bridge.welcomeSeen.v1', '1'));
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

test('four steps show only native transfer bytes and ETA, with expandable details', async () => {
  native(); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('heading', { name: 'Getting your workspace ready' });
  const steps = screen.getByRole('list', { name: 'Setup steps' });
  expect(within(steps).getAllByRole('listitem')).toHaveLength(4);
  for (const name of ['Where agents run', 'Get your workspace ready', 'Choose the AI your agent uses', 'Run your first test']) expect(within(steps).getByText(name)).toBeTruthy();
  expect(screen.getByText('Installing, 1.1 GiB of 2.8 GiB')).toBeTruthy();
  expect(screen.getByText('30 seconds left')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('1200000000');
  expect(screen.queryByText(/Downloading/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Connect model' })).toBeNull();
  expect(screen.queryByText('Checking workspace files')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText('Checking workspace files')).toBeTruthy();
  expect(screen.getAllByText('Starting workspace').length).toBeGreaterThan(0);
});

test('startup shows a moving indeterminate bar and native elapsed time near the top', async () => {
  native('starting', { phase: 'starting', bytes: null, totalBytes: null, elapsedMs: 42000, remainingMs: null }); render(<App />);
  const bar = await screen.findByRole('progressbar', { name: 'Workspace startup' });
  expect(bar.hasAttribute('value')).toBe(false);
  expect(screen.getByText('42 seconds elapsed')).toBeTruthy();
  expect(bar.closest('li')?.textContent).toContain('Get your workspace ready');
  expect(bar.closest('main')).toBeTruthy();
  expect(screen.queryByText(/seconds left/)).toBeNull();
});

test('unavailable progress never fabricates bytes or time left', async () => {
  native('installing', null); render(<App />);
  await screen.findByRole('list', { name: 'Setup steps' });
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText(/seconds left|minute left|of .*GB/)).toBeNull();
});

test('keyboard Cancel then start again calls native retry and keeps the Meet panel', async () => {
  const { ipc } = native(); const user = userEvent.setup(); render(<App />);
  const cancel = await screen.findByRole('button', { name: 'Cancel' }); cancel.focus();
  await user.keyboard('{Enter}');
  const retry = await screen.findByRole('button', { name: 'Start again' });
  expect(screen.getByText('What has arrived is kept.')).toBeTruthy();
  retry.focus(); await user.keyboard(' ');
  await screen.findByRole('button', { name: 'Cancel' });
  expect(ipc.mock.calls.filter(([c]) => c === 'setup_cancel_local')).toHaveLength(1);
  expect(ipc.mock.calls.filter(([c]) => c === 'setup_select_local')).toHaveLength(1);
});

test('Meet opens the actual example read-only without owned-file or Run commands', async () => {
  const { ipc } = native(); const user = userEvent.setup(); render(<App />);
  expect(await screen.findByRole('heading', { name: 'web-reader' })).toBeTruthy();
  expect(screen.getByText('Answers from the web page named in the request')).toBeTruthy();
  expect(await within(screen.getByRole('navigation')).findByText('web-reader, ready to read')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Read its instructions' }));
  const main = screen.getByRole('main', { name: 'web-reader' });
  expect(within(main).getByText('Fetch before answering.')).toBeTruthy();
  const run = within(main).getByRole('button', { name: 'Run test' });
  expect(run.matches(':disabled')).toBe(true);
  expect(run.title).toBe('Wait for your workspace and AI to be ready');
  await user.click(within(main).getByRole('button', { name: 'File' }));
  const editor = screen.getByRole('textbox', { name: 'Agent file' }) as HTMLTextAreaElement;
  expect(editor.readOnly).toBe(true); editor.focus(); await user.keyboard('{Control>}s{/Control}');
  expect(ipc.mock.calls.some(([c]) => ['agent_open', 'agent_save', 'setup_run_example', 'setup_run_status'].includes(c))).toBe(false);
  expect(within(screen.getByRole('navigation')).getByText('web-reader, ready to read')).toBeTruthy();
});

test('unreadable status never upgrades the setup preview into an editable file', async () => {
  const { ipc, unreadable } = native(); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Read its instructions' }));
  unreadable();
  await waitFor(() => expect(within(screen.getByRole('contentinfo')).getByText('Workspace unavailable')).toBeTruthy());
  await user.click(screen.getByRole('button', { name: 'File' }));
  expect((screen.getByRole('textbox', { name: 'Agent file' }) as HTMLTextAreaElement).readOnly).toBe(true);
  expect(ipc.mock.calls.some(([c]) => ['agent_open', 'agent_save', 'setup_run_status'].includes(c))).toBe(false);
});

test('read-only view is freshly opened as editable only once setup is ready', async () => {
  const { ipc, ready } = native(); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Read its instructions' }));
  expect(ipc.mock.calls.some(([c]) => c === 'agent_open')).toBe(false);
  ready();
  await waitFor(() => expect(ipc.mock.calls.filter(([c]) => c === 'agent_open')).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: 'File' }));
  expect((screen.getByRole('textbox', { name: 'Agent file' }) as HTMLTextAreaElement).readOnly).toBe(false);
});

test('an established Designer stays editable when a running workspace later fails', async () => {
  const { ipc, fail } = native('ready'); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Open example' }));
  await screen.findByRole('heading', { name: 'web-reader', level: 1 });
  await user.click(screen.getByRole('button', { name: 'File' }));
  const editor = screen.getByRole('textbox', { name: 'Agent file' }); fail();
  await within(screen.getByRole('contentinfo')).findByText('Setup paused', {}, { timeout: 2000 });
  expect(screen.getByRole('textbox', { name: 'Agent file' })).toBe(editor);
  expect((editor as HTMLTextAreaElement).readOnly).toBe(false);
  expect(ipc.mock.calls.filter(([c]) => c === 'agent_open')).toHaveLength(1);
});

test('failure is one plain red step, native details stay behind disclosure', async () => {
  native('failed'); const user = userEvent.setup(); render(<App />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain("The workspace couldn't start.");
  expect(alert.textContent).toContain('What you downloaded is kept.');
  expect(alert.closest('li')?.classList.contains('step-failed')).toBe(true);
  expect(screen.queryByText('PRIVATE_NATIVE_DETAIL')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText('PRIVATE_NATIVE_DETAIL')).toBeTruthy();
});

test('Designer stays read-only while the first native setup observation is pending', async () => {
  const { ipc } = native(); let observe!: (value: unknown) => void;
  mockIPC(command => command === 'setup_status' ? new Promise(resolve => { observe = resolve; }) : ipc(command));
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole('button', { name: 'Designer' }));
  await screen.findByRole('heading', { name: 'web-reader', level: 1 });
  expect(ipc.mock.calls.some(([command]) => command === 'agent_open')).toBe(false);
  observe({ selected: 'localVm', localVm: 'installing', model: 'locked' });
  await within(screen.getByRole('contentinfo')).findByText('Setting up, step 2 of 4');
  expect(screen.getByRole('button', { name: 'Run test' }).matches(':disabled')).toBe(true);
});

test('opening Designer while Continue awaits native admission cannot open an owned file', async () => {
  const { ipc } = native(); let admit!: (value: unknown) => void; let started = false;
  mockIPC(command => command === 'setup_status' ? { selected: started ? 'localVm' : null, localVm: started ? 'installing' : 'idle', model: 'locked' }
    : command === 'setup_select_local' ? new Promise(resolve => { admit = resolve; }) : ipc(command));
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Designer' }));
  await screen.findByRole('heading', { name: 'web-reader', level: 1 });
  expect(ipc.mock.calls.some(([command]) => command === 'agent_open')).toBe(false);
  expect(screen.getByRole('button', { name: 'Run test' }).matches(':disabled')).toBe(true);
  started = true; admit({ selected: 'localVm', localVm: 'installing', model: 'locked' });
  await within(screen.getByRole('contentinfo')).findByText('Setting up, step 2 of 4');
});

test('a failed example read is not presented as an endless load', async () => {
  const { ipc } = native(); mockIPC(command => command === 'setup_example' ? Promise.reject('unavailable') : ipc(command)); render(<App />);
  expect(await screen.findByText('The example could not be opened. Try opening Designer.')).toBeTruthy();
  expect(screen.queryByText('Opening the example\'s introduction…')).toBeNull();
});

test.each(['running', 'passed', 'failed', 'unknown'] as const)('the last setup step reflects actual %s run evidence', async result => {
  const { ipc } = native('ready');
  const snapshot = { state: result === 'running' ? 'running' : 'complete', canRun: result !== 'running', report: result === 'running' ? null : { verdict: result, cases: [{ id: 'checksum', phase: 'Succeeded', answer: 'checksum', completedTools: ['web_fetch'], verdict: result, assertions: [{ id: 'value', kind: 'contains', verdict: result }] }] }, acknowledged: [], pending: null, error: null };
  mockIPC(command => command === 'setup_run_status' ? snapshot : ipc(command));
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Open example' }));
  await screen.findByRole('heading', { name: 'web-reader', level: 1 });
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  await waitFor(() => expect(screen.getByRole('list', { name: 'Setup steps' }).children[3].textContent).toContain({ running: 'Running', passed: 'Passed', failed: 'Failed', unknown: 'Result unknown' }[result]));
});

test('changing workspace and starting again preserves an owned draft after a failed save', async () => {
  const { ipc } = native('ready'); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Open example' }));
  await screen.findByRole('heading', { name: 'web-reader', level: 1 });
  await user.click(screen.getByRole('button', { name: 'File' }));
  const editor = screen.getByRole('textbox', { name: 'Agent file' }) as HTMLTextAreaElement;
  await user.type(editor, 'Retained draft');
  await screen.findByText('Your changes could not be saved. Your draft is still here.');
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  await user.click(screen.getByRole('button', { name: 'Change where agents run' }));
  await user.click(screen.getByRole('button', { name: 'Stop workspace and change' }));
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  await screen.findByRole('button', { name: 'Cancel' });
  await user.click(screen.getByRole('button', { name: 'Designer' }));
  expect(screen.getByRole('textbox', { name: 'Agent file' })).toBe(editor);
  expect(editor.value).toContain('Retained draft');
  expect(ipc.mock.calls.filter(([c]) => c === 'agent_open')).toHaveLength(1);
});

test('the AI step resets after a connected workspace leaves ready', async () => {
  const { fail } = native('ready'); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Use GitHub sign-in' }));
  await screen.findByText('Model connected: copilot / gpt-5.6-terra.'); fail();
  await within(screen.getByRole('contentinfo')).findByText('Setup paused', {}, { timeout: 2000 });
  await waitFor(() => expect(screen.getByRole('list', { name: 'Setup steps' }).children[2].textContent).not.toContain('Connected'));
});

test('a delayed Cancel shows pending stop near the top instead of old byte progress', async () => {
  const { ipc } = native(); let done!: (value: unknown) => void;
  mockIPC(command => command === 'setup_cancel_local' ? new Promise(resolve => { done = resolve; }) : ipc(command));
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Stopping your workspace…')).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
  done({ selected: 'localVm', localVm: 'cancelled', model: 'locked' });
  await screen.findByRole('button', { name: 'Start again' });
});

test('model settling during Change cannot strand subsequent Continue actions', async () => {
  native('ready'); let connect!: (value: unknown) => void; let change!: (value: unknown) => void; let selected: 'localVm' | null = 'localVm';
  mockIPC(command => command === 'setup_status' ? { selected, localVm: selected ? 'ready' : 'cancelled', model: selected ? 'available' : 'locked' }
    : command === 'setup_connect_model' ? new Promise(resolve => { connect = resolve; })
    : command === 'setup_change_local' ? new Promise(resolve => { change = resolve; })
    : command === 'setup_select_local' ? { selected: 'localVm', localVm: 'installing', model: 'locked' }
    : Promise.reject('unavailable'));
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Use GitHub sign-in' }));
  await user.click(screen.getByRole('button', { name: 'Change where agents run' }));
  await user.click(screen.getByRole('button', { name: 'Stop workspace and change' }));
  connect({ ready: true }); await screen.findByText('Model connected: copilot / gpt-5.6-terra.');
  selected = null; change({ selected: null, localVm: 'cancelled', model: 'locked' });
  const next = await screen.findByRole('button', { name: 'Continue' });
  expect(next.matches(':disabled')).toBe(false);
});

test('Cancel and Start again restore keyboard focus after replacing the action', async () => {
  native(); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  await screen.findByRole('button', { name: 'Start again' });
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Getting your workspace ready', level: 1 }));
  await user.click(screen.getByRole('button', { name: 'Start again' }));
  await screen.findByRole('button', { name: 'Cancel' });
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Getting your workspace ready', level: 1 }));
});

test('keeping the workspace running returns focus to the confirmation invoker', async () => {
  native('ready'); const user = userEvent.setup(); render(<App />);
  const invoker = await screen.findByRole('button', { name: 'Change where agents run' });
  await user.click(invoker); await user.click(screen.getByRole('button', { name: 'Keep workspace running' }));
  expect(document.activeElement).toBe(invoker);
});

test('Change where agents run does not stop until confirmed, and returns to chooser', async () => {
  const { ipc } = native('ready'); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Change where agents run' }));
  expect(ipc.mock.calls.some(([c]) => c === 'setup_change_local')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Keep workspace running' }));
  expect(ipc.mock.calls.some(([c]) => c === 'setup_change_local')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Change where agents run' }));
  await user.click(screen.getByRole('button', { name: 'Stop workspace and change' }));
  expect(await screen.findByRole('heading', { name: 'Where should your agents run?' })).toBeTruthy();
  expect(ipc.mock.calls.filter(([c]) => c === 'setup_change_local')).toHaveLength(1);
});
