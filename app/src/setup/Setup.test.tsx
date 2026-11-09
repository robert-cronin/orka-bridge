import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../App';

const status = (selected: 'localVm' | null = null) => ({ selected, localVm: 'notIntegrated', model: 'locked' });
const unavailable = 'Workspace setup is not included in this build. Nothing will be downloaded or started.';
function native() {
  vi.stubGlobal('isTauri', true);
  let selected: 'localVm' | null = null;
  const ipc = vi.fn((command: string) => {
    if (command === 'setup_status') return status(selected);
    if (command === 'setup_requirements') return null;
    if (command === 'setup_select_local') { selected = 'localVm'; return status(selected); }
    throw new Error('Forbidden command: ' + command);
  });
  mockIPC(ipc);
  return ipc;
}
beforeEach(() => { localStorage.setItem('bridge.welcomeSeen.v1', '1'); });
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

test('running native session unlocks only its explicit model command', async () => {
  vi.stubGlobal('isTauri', true);
  const ipc = vi.fn((command: string) => {
    if (command === 'setup_status') return { selected: 'localVm', localVm: 'ready', model: 'available' };
    if (command === 'setup_connect_model') return { ready: true };
    throw new Error('Forbidden command');
  });
  const user = userEvent.setup(); mockIPC(ipc); render(<App />);
  const connect = await screen.findByRole('button', { name: 'Use GitHub sign-in' });
  expect(connect.hasAttribute('disabled')).toBe(false);
  expect(ipc.mock.calls.some(([command]) => command === 'setup_connect_model')).toBe(false);
  await user.click(connect);
  expect(await screen.findByText('Model connected: copilot / gpt-5.6-terra.')).toBeTruthy();
  expect(ipc.mock.calls.filter(([command]) => command === 'setup_connect_model')).toEqual([['setup_connect_model', {}]]);
});
test('failed Connect refreshes retained guest details without locking the running VM', async () => {
  vi.stubGlobal('isTauri', true);
  let failed = false;
  const detail = 'Guest Connect: gateway, timeout, 60000 ms. Stderr withheld.';
  const ipc = vi.fn((command: string) => {
    if (command === 'setup_status') return { selected: 'localVm', localVm: 'ready', model: 'available', localVmError: failed ? detail : null };
    if (command === 'engine_call') throw { kind: 'unavailable' };
    if (command === 'setup_connect_model') { failed = true; throw { kind: 'modelConnect', message: 'SECRET_MARKER' }; }
    throw new Error('Forbidden command');
  });
  const user = userEvent.setup(); mockIPC(ipc); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Use GitHub sign-in' }));
  expect(screen.queryByText(detail)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Show details' }));
  expect(await screen.findByText(detail)).toBeTruthy();
  expect(screen.getByText('Your workspace is running on this computer.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Use GitHub sign-in' }).matches(':disabled')).toBe(false);
  expect(document.body.textContent).not.toContain('SECRET_MARKER');
  expect(ipc.mock.calls.filter(([command]) => command === 'setup_connect_model')).toHaveLength(1);
});

test('the chooser only reads setup and build information, without runtime or credential effects', async () => {
  const ipc = native(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render(<App />);
  expect(await screen.findByRole('heading', { name: 'Where should your agents run?' })).toBeTruthy();
  expect(screen.getByText(unavailable)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect model' })).toBeNull();
  const existing = screen.getByRole('radio', { name: 'On a cluster you already have' });
  expect(existing.hasAttribute('disabled')).toBe(true);
  const before = ipc.mock.calls.length; fireEvent.click(existing);
  expect(ipc).toHaveBeenCalledTimes(before);
  expect(ipc.mock.calls.every(call => ['setup_status', 'setup_requirements', 'engine_call'].includes(call[0]))).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(screen.queryByRole('textbox')).toBeNull();
});

test('remount observes the native choice without inventing workspace or model readiness', async () => {
  const ipc = native(); const user = userEvent.setup(); const first = render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('region', { name: 'Workspace setup' })).toBeTruthy();
  first.unmount(); render(<App />);
  await screen.findByRole('region', { name: 'Workspace setup' });
  expect(screen.getByText(unavailable)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect model' })).toBeNull();
  expect(ipc.mock.calls.filter(call => call[0] === 'setup_select_local')).toEqual([['setup_select_local', {}]]);
});

test('browser preview never pretends that native persistence or integration works', async () => {
  vi.stubGlobal('isTauri', false); const ipc = vi.fn(); mockIPC(ipc); render(<App />);
  expect(await screen.findByText('Workspace setup is not available in this preview.')).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'On this computer' }).matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Continue' }).matches(':disabled')).toBe(true);
  expect(ipc).not.toHaveBeenCalled();
});

test('unsupported native replies cannot claim availability or leak extra data', async () => {
  native(); mockIPC(command => command === 'setup_status'
    ? { ...status(), model: 'ready', credential: 'SECRET_MARKER' } : Promise.reject({ kind: 'unavailable' }));
  render(<App />); expect(await screen.findByRole('alert')).toBeTruthy();
  expect(document.body.textContent).not.toContain('SECRET_MARKER');
  expect(screen.getByRole('button', { name: 'Continue' }).matches(':disabled')).toBe(true);
});

test('save failures do not mark the choice saved and never render rejected paths', async () => {
  native(); mockIPC(command => command === 'setup_status' ? status() : command === 'setup_requirements' ? null
    : Promise.reject({ kind: 'storage', message: '/private/SECRET_MARKER' }));
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Workspace setup' })).toBeNull();
  expect(document.body.textContent).not.toContain('SECRET_MARKER');
});

test('a failed initial read can be checked again without changing the saved choice', async () => {
  native(); let reads = 0;
  mockIPC(command => command === 'setup_status'
    ? ++reads === 1 ? Promise.reject('SECRET_MARKER') : status('localVm') : Promise.reject({ kind: 'unavailable' }));
  const user = userEvent.setup(); render(<App />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Workspace setup' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByRole('region', { name: 'Workspace setup' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('Continue shows real startup states and a ready session can open the owned example', async () => {
  native(); let selected: 'localVm' | null = null; let reads = 0;
  const ipc = vi.fn((command: string) => {
    if (command === 'setup_select_local') { selected = 'localVm'; return { ...status(selected), localVm: 'preparing' }; }
    if (command === 'setup_status') return { ...status(selected), localVm: selected === null ? 'idle' : ++reads === 1 ? 'starting' : 'ready' };
    if (command === 'setup_requirements') return null;
    if (command === 'agent_open') return { agent: 'exact agent source', tests: 'exact test source' };
    if (command === 'setup_run_status') return { state: 'idle', canRun: true, report: null, acknowledged: [], pending: null, error: null };
    throw { kind: 'unavailable' };
  }); mockIPC(ipc);
  const user = userEvent.setup(); render(<App />);
  await screen.findByRole('button', { name: 'Continue' });
  expect(screen.queryByRole('button', { name: 'Open example' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.queryByText('Your workspace is running on this computer.')).toBeNull();
  expect(await screen.findByText('Your workspace is running on this computer.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Connect model' }).matches(':disabled')).toBe(true);
  expect(ipc.mock.calls.filter(([name]) => name === 'setup_select_local')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Open example' }));
  expect(await screen.findByText('exact agent source')).toBeTruthy();
  expect(screen.getByText('exact test source')).toBeTruthy();
  expect(ipc.mock.calls.every(([name]) => ['setup_status', 'setup_requirements', 'setup_select_local', 'setup_example', 'agent_open', 'setup_run_status', 'engine_call'].includes(name))).toBe(true);
});

test.each([
  'Starting the local VM failed: Runtime operation failed: Io(<b data-vm-error>launch detail</b>)',
  'Stopping the local VM failed: Runtime operation failed: Io(<b data-vm-error>stop detail</b>)',
])('keeps retained failure reason plain and behind disclosure: %s', async localVmError => {
  native(); mockIPC(command => command === 'setup_status'
    ? { ...status('localVm'), localVm: 'failed', localVmError } : Promise.reject({ kind: 'unavailable' }));
  const user = userEvent.setup(); render(<App />);
  expect((await screen.findByRole('alert')).textContent).toContain('What you downloaded is kept.');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByText(localVmError)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText(localVmError)).toBeTruthy();
  expect(document.querySelector('[data-vm-error]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open example' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Connect model' })).toBeNull();
});

test('a delayed Continue reply stays pending across repeat activation and navigation', async () => {
  native(); let complete!: (value: unknown) => void; let selected: 'localVm' | null = null;
  const ipc = vi.fn(command => command === 'setup_status' ? status(selected) : command === 'setup_select_local'
    ? new Promise(resolve => { complete = resolve; }) : Promise.reject({ kind: 'unavailable' }));
  mockIPC(ipc);
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(screen.getByRole('button', { name: 'Continue' }).matches(':disabled')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  const designer = screen.getByRole('button', { name: 'Designer' });
  await user.click(designer); selected = 'localVm'; complete(status(selected));
  await waitFor(() => expect(document.querySelector('[aria-label="Workspace setup"]')?.closest('[hidden]')).toBeTruthy());
  expect(screen.getByRole('main', { name: 'Designer' })).toBeTruthy();
  expect(document.activeElement).toBe(designer);
  expect(screen.queryByRole('region', { name: 'Workspace setup' })).toBeNull();
  expect(ipc.mock.calls.filter(([command]) => command === 'setup_select_local')).toEqual([['setup_select_local', {}]]);
  expect(ipc.mock.calls.some(([command]) => command === 'setup_connect_model')).toBe(false);
});
