import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import Run from './Run';
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });
const idle = { state: 'idle', canRun: true, report: null, acknowledged: [], pending: null, error: null };
const complete = { ...idle, state: 'complete', report: { verdict: 'unknown', cases: [{ id: 'published-checksum', phase: 'Succeeded', answer: '<script>not executable</script>', completedTools: [], assertions: [{ id: 'checksum-from-page', kind: 'contains', verdict: 'passed' }, { id: 'fetched-page', kind: 'toolCalled', verdict: 'unknown' }], verdict: 'unknown' }] } };
test('Run is explicit, duplicate clicks and remounts only observe existing work', async () => {
  vi.stubGlobal('isTauri', true); let value: unknown = idle;
  const ipc = vi.fn(command => {
    if (command === 'setup_run_example') value = { ...idle, state: 'running', canRun: false };
    return value;
  }); mockIPC(ipc);
  const view = render(<Run />); const button = await screen.findByRole('button', { name: 'Run test' });
  await userEvent.dblClick(button); expect(ipc.mock.calls.filter(([cmd]) => cmd === 'setup_run_example')).toHaveLength(1);
  view.unmount(); render(<Run />); expect(await screen.findByText('Running on the local VM…')).toBeTruthy();
  expect(ipc.mock.calls.filter(([cmd]) => cmd === 'setup_run_example')).toHaveLength(1);
  value = complete;
  expect(await screen.findByText('<script>not executable</script>')).toBeTruthy();
  expect(screen.getByText('contains: passed')).toBeTruthy(); expect(screen.getByText('toolCalled: unknown')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull(); expect(screen.getByText('No completed tool calls were observed. Missing evidence is unknown.')).toBeTruthy();
});
test('model connection advice follows the acknowledged model state, not Run availability', async () => {
  vi.stubGlobal('isTauri', true);
  let modelConnected = false;
  mockIPC(() => ({ ...idle, state: 'running', canRun: false, modelConnected }));
  const view = render(<Run />);
  expect(screen.queryByText(/Connect the model in Clusters first\./)).toBeNull();
  expect(await screen.findByText(/Connect the model in Clusters first\./)).toBeTruthy();
  modelConnected = true;
  view.unmount();
  render(<Run />);
  expect(await screen.findByText('Running on the local VM…')).toBeTruthy();
  expect(screen.queryByText(/Connect the model in Clusters first\./)).toBeNull();
  expect(screen.getByRole('button', { name: 'Run test' }).title).toBe('Check is running');
});
test.each([
  { error: 'model', modelConnected: false, alert: true },
  { error: 'model', modelConnected: true, alert: false },
  { error: 'submit', modelConnected: true, alert: true },
  { error: 'session', modelConnected: true, alert: true },
])('retained $error advice follows native connection state without hiding other errors', async ({ error, modelConnected, alert }) => {
  vi.stubGlobal('isTauri', true);
  mockIPC(() => ({ ...idle, state: 'unknown', error, modelConnected }));
  render(<Run />);
  // Wait for the native response, not the initial disabled rendering.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run test' }).hasAttribute('disabled')).toBe(false));
  expect(!!screen.queryByRole('alert')).toBe(alert);
});
test('uncertain submission names retained receipts and never retries automatically', async () => {
  vi.stubGlobal('isTauri', true); const ipc = vi.fn((command: string) => { expect(command).toBe('setup_run_status'); return { ...idle, state: 'unknown', error: 'submit', acknowledged: [{ kind: 'Agent', name: 'bridge-run-example', uid: 'uid-a' }], pending: { kind: 'Task', name: 'bridge-task-example' } }; }); mockIPC(ipc); render(<Run />);
  expect(await screen.findByText(/bridge-task-example/)).toBeTruthy(); expect(screen.getByText(/bridge-run-example/)).toBeTruthy();
  expect(ipc.mock.calls.every(([cmd]) => cmd === 'setup_run_status')).toBe(true);
});
test.each([null, { ...idle, modelConnected: 'true' }, { ...idle, state: ['idle'] }, { ...idle, error: 'PRIVATE_DIAGNOSTIC' }, { ...complete, extra: 'PRIVATE_DIAGNOSTIC' }, { ...complete, report: { ...complete.report, verdict: 'passed', cases: [{ secret: 'PRIVATE_DIAGNOSTIC' }] } }])('malformed Run data never renders raw diagnostics', async value => {
  vi.stubGlobal('isTauri', true); mockIPC(() => value); render(<Run />); expect(await screen.findByText('Run information is not supported by this build.')).toBeTruthy(); expect(document.body.textContent).not.toContain('PRIVATE_DIAGNOSTIC');
});
test('preview never fabricates a native test or sends Run IPC', async () => {
  vi.stubGlobal('isTauri', false); const ipc = vi.fn(); mockIPC(ipc); render(<Run />);
  expect(await screen.findByText('Run is available only in the native app.')).toBeTruthy(); expect(ipc).not.toHaveBeenCalled();
});
