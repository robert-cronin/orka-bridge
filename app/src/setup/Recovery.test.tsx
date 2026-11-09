import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../App';

let detail: string | null;
function native(error: string | null) {
  detail = error; vi.stubGlobal('isTauri', true);
  let localVm = 'failed';
  const status = () => ({ selected: 'localVm', localVm, model: localVm === 'ready' ? 'available' : 'locked', localVmError: detail });
  const ipc = vi.fn((command: string) => {
    if (command === 'setup_status') return status();
    if (command === 'setup_select_local') { localVm = 'starting'; detail = null; return status(); }
    if (command === 'setup_open_help') return null;
    if (command === 'setup_connect_model') throw { kind: 'modelConnect' };
    if (command === 'setup_example') return { agent: '---\nname: web-reader\n---\nRead a page.', tests: 'A check.' };
    throw Error('Unsupported fake command');
  });
  mockIPC(ipc);
  return { ipc, ready: () => { localVm = 'ready'; } };
}
beforeEach(() => localStorage.setItem('bridge.welcomeSeen.v1', '1'));
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

// Changing classification/order makes these fail even if all button labels stay the same.
test.each([
  ['virtualizationDisabled', 'Virtualization is turned off on this PC.', 'virtualization'],
  ['hypervisorUnavailable', "Windows Hypervisor Platform (Hyper-V) isn't available.", 'hypervisor'],
  ['Image(NoSpace)', "There isn't enough free space for the workspace.", 'workspace'],
  ['Fill private state disk: Io(Os { code: 112, kind: StorageFull })', "There isn't enough free space for the workspace.", 'workspace'],
  ['Image(Integrity)', "The workspace files couldn't be verified.", 'workspace'],
  ['Pin installed boot files: Io(failure)', "The workspace files couldn't be verified.", 'workspace'],
  ['RetainedState', "The workspace files are still in use or need checking.", 'workspace'],
])('fix-first failure %s puts working help before retry', async (error, summary, topic) => {
  const { ipc } = native(`Starting the local VM failed: ${error}`);
  const user = userEvent.setup(); render(<App />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(summary);
  const buttons = within(alert).getAllByRole('button');
  expect(buttons.slice(0, 3).map(button => button.textContent)).toEqual(['Show me how', 'Try again', 'Copy details for help']);
  buttons[0].focus(); await user.keyboard('{Enter}');
  expect(ipc).toHaveBeenCalledWith('setup_open_help', { topic });
  expect(screen.getByRole('contentinfo').textContent).toContain('Setup paused');
  expect(screen.getByRole('contentinfo').textContent).toContain(summary);
  expect(within(alert).getByText('What you downloaded is kept.')).toBeTruthy();
  const fallback = screen.getByRole('button', { name: 'Use a cluster you already have instead' });
  expect(fallback.matches(':disabled')).toBe(true);
  expect(fallback.title).toBe('Connecting an existing cluster is coming');
});

test.each([
  ['Image(Network("connection"))', "The workspace files couldn't be downloaded."],
  ['Fill private state disk: Io(failure)', "The workspace files couldn't be prepared."],
  ['Run qemu-img: Io(failure)', "The workspace files couldn't be prepared."],
  ['Prepare QEMU control endpoint: Io(failure)', "The workspace couldn't start."],
  ['Create QEMU process: Io(failure)', "The workspace couldn't start."],
  ['Open QEMU standard I/O: Io(failure)', "The workspace couldn't start."],
  ['Resume QEMU process: Io(failure)', "The workspace couldn't start."],
  ['Negotiate QMP: Io(failure)', "The workspace couldn't start."],
  ['Check QEMU prelaunch status: Io(failure)', "The workspace couldn't start."],
  ['Connect guest control: Io(failure)', "The workspace didn't finish starting."],
  ['Start guest CPUs: Io(failure)', "The workspace couldn't start."],
  ['Establish guest session: Io(failure)', "The workspace didn't finish starting."],
  ['Orka infrastructure failed (phase: Some(InfrastructureFailed), service: Failed)', "The workspace's services couldn't start."],
  [null, "The workspace couldn't start."],
  ['Mac launch error: Io(failure)', "The workspace couldn't start."],
])('retry failure %s leads with retry and exposes real details on request', async (error, summary) => {
  native(error); const user = userEvent.setup(); render(<App />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(summary);
  expect(within(alert).getAllByRole('button')[0].textContent).toBe('Try again');
  if (error) expect(screen.queryByText(error)).toBeNull();
  const disclosure = within(alert).getByRole('button', { name: 'Show details' });
  disclosure.focus(); await user.keyboard(' ');
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'Hide details' })).toBe(disclosure);
  if (error) expect(screen.getByText(error).tagName).toBe('PRE');
});

test('keyboard retry calls the existing native selection once and returns to progress', async () => {
  const { ipc } = native('Create QEMU process: Io(failure)');
  const user = userEvent.setup(); render(<App />);
  const retry = await screen.findByRole('button', { name: 'Try again' });
  retry.focus(); await user.keyboard('{Enter}{Enter}');
  await screen.findByRole('progressbar', { name: 'Workspace startup' });
  expect(ipc.mock.calls.filter(([command]) => command === 'setup_select_local')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('copy includes recognized stage and error code, never arbitrary errors, paths or credentials', async () => {
  native('Starting the local VM failed: Create QEMU process: Io(Os { code: 5, message: "ghp_NOT_FOR_HELP Bearer PRIVATE" }). QEMU: token=private-key. Details: C:\\Users\\private');
  const user = userEvent.setup(); const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Copy details for help' }));
  expect(copy).toHaveBeenCalledTimes(1);
  const text = copy.mock.calls[0][0];
  expect(text).toContain('Create QEMU process'); expect(text).toContain('code: 5');
  expect(text).not.toMatch(/ghp_|Bearer|PRIVATE|private|Users|QEMU:/);
  expect(screen.getByText('Details copied. Private diagnostic text is not included.')).toBeTruthy();
});

test('copy and help failures give a next action without echoing rejected text', async () => {
  const { ipc } = native('virtualizationDisabled');
  ipc.mockImplementation(command => {
    if (command === 'setup_status') return { selected: 'localVm', localVm: 'failed', model: 'locked', localVmError: detail };
    throw 'SECRET';
  });
  const user = userEvent.setup(); vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue('SECRET'); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Copy details for help' }));
  expect(screen.getByText("Couldn't copy. Open Show details to read the error.")).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Show me how' }));
  expect(screen.getByText("Couldn't open help. Open Show details and ask for help with this error.")).toBeTruthy();
  expect(screen.queryByText('SECRET')).toBeNull();
});

test.each(['Stopping the local VM failed: Io(stop detail)', 'Starting the local VM failed: startupStopFailed: QEMU cleanup failed'])('unconfirmed stop explains why retry cannot launch a second workspace: %s', async error => {
  native(error); render(<App />);
  expect((await screen.findByRole('alert')).textContent).toContain("The workspace couldn't be stopped safely.");
  expect(screen.getByRole('button', { name: 'Try again' }).matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Try again' }).title).toContain('Quit Bridge');
});

test('model failure is not duplicated in workspace details', async () => {
  const message = 'Guest Connect did not acknowledge a ready model. Completion is unknown.';
  const { ready } = native(`${message} Guest Connect: {"stage":"gateway","code":"timeout"}`); ready();
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Use GitHub sign-in' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
  await user.click(screen.getByRole('button', { name: 'Show details' }));
  expect(document.body.textContent?.split(message)).toHaveLength(2);
  expect(screen.getByText('Guest Connect: {"stage":"gateway","code":"timeout"}')).toBeTruthy();
});
