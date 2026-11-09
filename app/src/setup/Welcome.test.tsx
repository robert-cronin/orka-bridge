import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../App';

const preference = 'bridge.welcomeSeen.v1';
const unselected = { selected: null, localVm: 'idle', model: 'locked' };
const requirements = { memoryBytes: 6442450944, imageBytes: 3651994962, stateDiskBytes: 34359738368 };
function native(initial: object = unselected, sizing: unknown = requirements) {
  vi.stubGlobal('isTauri', true);
  let status = initial;
  const ipc = vi.fn((command: string) => {
    if (command === 'setup_status') return status;
    if (command === 'setup_requirements') return sizing;
    if (command === 'setup_select_local') {
      status = { selected: 'localVm', localVm: 'starting', model: 'locked' };
      return status;
    }
    throw new Error('Unsupported command');
  });
  mockIPC(ipc);
  return ipc;
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

test('Get started remembers the welcome without starting a workspace, including on remount', async () => {
  const ipc = native(); const user = userEvent.setup(); const first = render(<App />);
  expect(await screen.findByRole('heading', { name: 'Build an AI agent that does a real job' })).toBeTruthy();
  expect(screen.getByText('Write it')).toBeTruthy();
  expect(screen.getByText('Test it')).toBeTruthy();
  expect(screen.getByText('Share it')).toBeTruthy();
  expect(screen.queryByText(/5 minutes/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Get started' }));
  const heading = await screen.findByRole('heading', { name: 'Where should your agents run?' });
  expect(document.activeElement).toBe(heading);
  expect(localStorage.getItem(preference)).toBe('1');
  first.unmount(); render(<App />);
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();
  expect(ipc.mock.calls.some(([command]) => command === 'setup_select_local')).toBe(false);
});

test('welcome chrome advances only after Get started, including with denied preference storage', async () => {
  native(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
  const user = userEvent.setup(); render(<App />);
  expect(await within(screen.getByRole('navigation')).findByText('Start here')).toBeTruthy();
  expect(within(screen.getByRole('contentinfo')).getByText('Nothing is set up yet')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Get started' }));
  expect(within(screen.getByRole('navigation')).getByText('Setting up, step 1 of 4')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Designer' }));
  expect(document.querySelectorAll('#page-title')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();
});

test('a saved native choice skips welcome even without a renderer preference', async () => {
  const ipc = native({ selected: 'localVm', localVm: 'starting', model: 'locked' }); render(<App />);
  expect(await screen.findByText('Starting your workspace…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();
  expect(ipc.mock.calls.some(([command]) => command === 'setup_select_local')).toBe(false);
});

test('disabled expert routes explain Coming and cannot select a workspace', async () => {
  const ipc = native(); const user = userEvent.setup(); render(<App />);
  const expert = await screen.findByRole('button', { name: 'I already run Orka on a cluster' });
  expect(expert.matches(':disabled')).toBe(true);
  expect(expert.closest('[title]')?.getAttribute('title')).toBe('Coming');
  await user.click(expert);
  await user.click(screen.getByRole('button', { name: 'Get started' }));
  const cluster = screen.getByRole('radio', { name: 'On a cluster you already have' });
  expect(cluster.matches(':disabled')).toBe(true);
  expect(cluster.closest('[title]')?.getAttribute('title')).toBe('Coming');
  expect(ipc.mock.calls.some(([command]) => command === 'setup_select_local')).toBe(false);
});

test('keyboard disclosure and radio selection are inert; only Continue starts once', async () => {
  localStorage.setItem(preference, '1'); const ipc = native(); const user = userEvent.setup(); render(<App />);
  const local = await screen.findByRole('radio', { name: 'On this computer' });
  local.focus(); await user.keyboard(' {ArrowRight}');
  const disclosure = screen.getByRole('button', { name: "What's inside" });
  const details = document.getElementById(disclosure.getAttribute('aria-controls')!);
  expect(details).not.toBeNull();
  expect(details?.hasAttribute('hidden')).toBe(true);
  disclosure.focus(); await user.keyboard('{Enter}');
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText(/open-source engine/)).toBeTruthy();
  expect(ipc.mock.calls.some(([command]) => command === 'setup_select_local')).toBe(false);
  const next = screen.getByRole('button', { name: 'Continue' });
  next.focus(); await user.keyboard('{Enter}{Enter}');
  expect(await screen.findByText('Starting your workspace…')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Getting your workspace ready' }));
  expect(ipc.mock.calls.filter(([command]) => command === 'setup_select_local')).toEqual([['setup_select_local', {}]]);
});

test('requirements render the native build values rather than fixed image or memory sizes', async () => {
  localStorage.setItem(preference, '1'); native(unselected, { memoryBytes: 8589934592, imageBytes: 18253611008, stateDiskBytes: 68719476736 });
  render(<App />);
  expect(await screen.findByText(/8 GiB of memory/)).toBeTruthy();
  expect(screen.getByText(/17 GiB workspace image/)).toBeTruthy();
  expect(screen.getByText(/64 GiB/)).toBeTruthy();
  expect(screen.queryByText(/6 GB|2 GB|6 GiB/)).toBeNull();
});

test('release welcome exposes unavailability before Get started without replacing the workflow copy', async () => {
  const ipc = native({ ...unselected, localVm: 'notIntegrated' }, null); render(<App />);
  expect(await screen.findByRole('button', { name: 'Get started' })).toBeTruthy();
  expect(screen.getByText('Workspace setup is not included in this build. Nothing will be downloaded or started.')).toBeTruthy();
  expect(screen.getByText('Share it')).toBeTruthy();
  expect(ipc.mock.calls.some(([command]) => command === 'setup_select_local')).toBe(false);
});

test('release-unavailable setup stays explicit and does not invent requirements', async () => {
  localStorage.setItem(preference, '1'); native({ ...unselected, localVm: 'notIntegrated' }, null); render(<App />);
  expect(await screen.findByText('Workspace setup is not included in this build. Nothing will be downloaded or started.')).toBeTruthy();
  expect(screen.queryByText(/GiB/)).toBeNull();
});

test.each(['getItem', 'setItem'] as const)('denied preference %s does not prevent setup', async method => {
  native(); vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Get started' }));
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
});

test.each([
  { ...requirements, imageBytes: -1 },
  { ...requirements, memoryBytes: Number.MAX_SAFE_INTEGER + 1 },
  { ...requirements, stateDiskBytes: 0 },
  { memoryBytes: 'SECRET_MARKER', imageBytes: 123, stateDiskBytes: 123 },
  { ...requirements, secret: 'SECRET_MARKER' },
])('unsupported sizing cannot produce requirements copy or leak data: %j', async value => {
  localStorage.setItem(preference, '1'); native(unselected, value); render(<App />);
  expect(await screen.findByText('Workspace size information is unavailable in this build.')).toBeTruthy();
  expect(screen.queryByText(/GiB/)).toBeNull();
  expect(document.body.textContent).not.toContain('SECRET_MARKER');
});

test('an unseen welcome cannot hide a failed status read or overwrite its preference', async () => {
  native(); let failed = true;
  const ipc = vi.fn(command => command === 'setup_status'
    ? failed ? Promise.reject('SECRET_MARKER') : { selected: 'localVm', localVm: 'starting', model: 'locked' }
    : command === 'setup_requirements' ? requirements : Promise.reject({ kind: 'unavailable' }));
  mockIPC(ipc); const user = userEvent.setup(); render(<App />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();
  expect(localStorage.getItem(preference)).toBeNull();
  failed = false;
  await user.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('Starting your workspace…')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(localStorage.getItem(preference)).toBeNull();
  expect(ipc.mock.calls.some(([command]) => command === 'setup_select_local')).toBe(false);
});

test('a delayed initial status cannot flash welcome over an existing workspace', async () => {
  native(); let complete!: (value: unknown) => void;
  mockIPC(command => command === 'setup_status' ? new Promise(resolve => { complete = resolve; })
    : command === 'setup_requirements' ? requirements : Promise.reject({ kind: 'unavailable' }));
  render(<App />);
  expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();
  complete({ selected: 'localVm', localVm: 'starting', model: 'locked' });
  await waitFor(() => expect(screen.getByText('Starting your workspace…')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();
});
