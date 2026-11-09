import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import Example from './Example';
const pair = { agent: '---\nname: web-reader\ndescription: Reads a page you name.\n---\nRead the page.\n', tests: 'Checks from disk' };
const idle = { state: 'idle', canRun: true, report: null, acknowledged: [], pending: null, error: null };
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });
function native(save?: (content: string) => unknown) {
  vi.stubGlobal('isTauri', true);
  mockIPC((command, args) => {
    if (command === 'agent_open') return pair;
    if (command === 'agent_save') return save ? save((args as { content: string }).content) : { ...pair, agent: (args as { content: string }).content };
    if (command === 'setup_run_status' || command === 'setup_run_example') return idle;
    throw Error(`Unexpected command ${command}`);
  });
}
test('opens the owned pair without a VM and exposes a keyboard File switch', async () => {
  native(); const user = userEvent.setup(); render(<Example />);
  expect(await screen.findByRole('heading', { name: 'web-reader', level: 1 })).toBeTruthy();
  expect(screen.getByText('Reads a page you name.', { selector: 'p' })).toBeTruthy();
  expect(screen.getByText('Checks from disk')).toBeTruthy();
  const chat = screen.getByRole('button', { name: 'Chat' });
  expect(chat.hasAttribute('disabled')).toBe(true); expect(chat.title).toMatch(/coming/i);
  screen.getByRole('button', { name: 'File' }).focus(); await user.keyboard('{Enter}');
  expect((screen.getByRole('textbox', { name: 'Agent file' }) as HTMLTextAreaElement).value).toBe(pair.agent);
});
test('does not claim Saved or allow Run before the commit reply', async () => {
  let finish!: (value: unknown) => void; let saved = '';
  native(content => { saved = content; return new Promise(resolve => { finish = resolve; }); });
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New instructions' } });
  fireEvent.blur(screen.getByRole('textbox'));
  await screen.findByText('Saving…');
  expect(screen.queryByText('Saved')).toBeNull();
  expect(screen.getByRole('button', { name: 'Run test' }).hasAttribute('disabled')).toBe(true);
  expect(saved).toBe('New instructions');
  await act(async () => finish({ ...pair, agent: saved }));
  await screen.findByText('Saved');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run test' }).hasAttribute('disabled')).toBe(false));
});
test('a newer draft survives a late save reply and is committed next', async () => {
  const writes: string[] = []; let finish!: (value: unknown) => void;
  native(content => { writes.push(content); return writes.length === 1 ? new Promise(resolve => { finish = resolve; }) : { ...pair, agent: content }; });
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'First draft' } }); fireEvent.blur(editor);
  await screen.findByText('Saving…');
  fireEvent.change(editor, { target: { value: 'Latest draft' } });
  await act(async () => finish({ ...pair, agent: 'First draft' }));
  await screen.findByText('Saved');
  expect(editor.value).toBe('Latest draft'); expect(writes).toEqual(['First draft', 'Latest draft']);
});
test('a failed commit retains the draft and retry saves the latest content', async () => {
  let fail = true;
  native(content => fail ? Promise.reject(new Error('private path')) : { ...pair, agent: content });
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my draft' } }); fireEvent.blur(screen.getByRole('textbox'));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(document.body.textContent).not.toContain('private path'); expect(screen.queryByText('Saved')).toBeNull();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep my draft');
  fail = false; await user.click(screen.getByRole('button', { name: 'Try saving again' }));
  await screen.findByText('Saved');
});
test('preserves CRLF files while editing and does not commit switching views', async () => {
  const crlf = { ...pair, agent: pair.agent.replaceAll('\n', '\r\n') }; const saves: string[] = [];
  vi.stubGlobal('isTauri', true); mockIPC((command, args) => command === 'agent_open' ? crlf : command === 'agent_save'
    ? (saves.push((args as { content: string }).content), { ...crlf, agent: saves.at(-1) }) : idle);
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  await user.click(screen.getByRole('button', { name: 'Agent' })); expect(saves).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'File' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed\ntext\n' } }); fireEvent.blur(screen.getByRole('textbox'));
  await screen.findByText('Saved'); expect(saves).toEqual(['Changed\r\ntext\r\n']);
});
test('returning to the saved bytes clears dirty state without another commit', async () => {
  const writes: string[] = []; native(content => { writes.push(content); return { ...pair, agent: content }; });
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Temporary draft' } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: pair.agent } }); fireEvent.blur(screen.getByRole('textbox'));
  await screen.findByText('Saved'); expect(writes).toEqual([]);
});
test.each([
  { older: false, autosave: false }, { older: true, autosave: false },
  { older: false, autosave: true }, { older: true, autosave: true },
])('edit then undo clears only draft staleness ($older, autosave $autosave)', async ({ older, autosave }) => {
  const source = { agent: 'a'.repeat(64), tests: 'c'.repeat(64) };
  const onStale = vi.fn();
  vi.stubGlobal('isTauri', true);
  mockIPC((command, args) => command === 'agent_open' ? { ...pair, source } : command === 'agent_save'
    ? { ...pair, agent: (args as { content: string }).content, source: (args as { content: string }).content === pair.agent ? source : { ...source, agent: 'd'.repeat(64) } } : {
    ...idle, state: 'complete', source: older ? { ...source, agent: 'b'.repeat(64) } : source,
    report: { verdict: 'passed', cases: [{ id: 'reads-page', phase: 'Succeeded', answer: 'Checked answer', completedTools: [], assertions: [{ id: 'contains-1', kind: 'contains', verdict: 'passed' }], verdict: 'passed' }] },
  });
  const user = userEvent.setup(); render(<Example onStale={onStale} />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  await screen.findByText(older ? 'Earlier test verdict: passed' : 'Test verdict: passed');
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'Temporary draft' } });
  expect(screen.getByText('Earlier test verdict: passed')).toBeTruthy();
  expect(onStale).toHaveBeenLastCalledWith(true);
  if (autosave) { fireEvent.blur(editor); await screen.findByText('Saved'); }
  fireEvent.change(editor, { target: { value: pair.agent } }); fireEvent.blur(editor);
  await screen.findByText('Saved');
  await waitFor(() => expect(onStale).toHaveBeenLastCalledWith(false));
  expect(screen.getByText(older ? 'Earlier test verdict: passed' : 'Test verdict: passed')).toBeTruthy();
  expect(!!screen.queryByText(/Not run since your change/)).toBe(older);
});
test('source-less replies keep an older verdict stale after undo to a newer saved file', async () => {
  vi.stubGlobal('isTauri', true);
  mockIPC((command, args) => command === 'agent_open' ? pair : command === 'agent_save'
    ? { ...pair, agent: (args as { content: string }).content }
    : { ...idle, state: 'complete', report: { verdict: 'passed', cases: [{ id: 'reads-page', phase: 'Succeeded', answer: 'Earlier answer', completedTools: [], assertions: [{ id: 'contains-1', kind: 'contains', verdict: 'passed' }], verdict: 'passed' }] } });
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  await screen.findByText('Test verdict: passed');
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'Saved newer file' } }); fireEvent.blur(editor);
  await screen.findByText('Saved');
  fireEvent.change(editor, { target: { value: 'Temporary draft' } });
  fireEvent.change(editor, { target: { value: 'Saved newer file' } }); fireEvent.blur(editor);
  await screen.findByText('Saved');
  expect(screen.getByText('Earlier test verdict: passed')).toBeTruthy();
  expect(screen.queryByText('Test verdict: passed')).toBeNull();
});
test('a failed Run request does not make an earlier verdict current after editing', async () => {
  vi.stubGlobal('isTauri', true);
  mockIPC((command, args) => {
    if (command === 'agent_open') return pair;
    if (command === 'agent_save') return { ...pair, agent: (args as { content: string }).content };
    if (command === 'setup_run_example') return Promise.reject(new Error('IPC failure'));
    return { ...idle, state: 'complete', report: { verdict: 'passed', cases: [{ id: 'reads-page', phase: 'Succeeded', answer: 'Earlier answer', completedTools: [], assertions: [{ id: 'contains-1', kind: 'contains', verdict: 'passed' }], verdict: 'passed' }] } };
  });
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New draft' } }); fireEvent.blur(screen.getByRole('textbox'));
  await screen.findByText('Saved');
  await user.click(screen.getByRole('button', { name: 'Run test' }));
  await screen.findByText('Run information is not supported by this build.');
  expect(screen.getByText('Earlier test verdict: passed')).toBeTruthy();
});
test('an edit during a delayed Run reply keeps the earlier result stale', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('isTauri', true);
  mockIPC((command, args) => command === 'agent_open' ? pair : command === 'agent_save' ? { ...pair, agent: (args as { content: string }).content }
    : command === 'setup_run_example' ? new Promise(resolve => { finish = resolve; }) : idle);
  const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  await user.click(screen.getByRole('button', { name: 'Run test' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited while submitting' } }); fireEvent.blur(screen.getByRole('textbox'));
  await screen.findByText('Saved');
  await act(async () => finish(idle));
  expect(screen.getByText(/Not run since your change/)).toBeTruthy();
});
test('remounting with an old native report keeps it visibly stale', async () => {
  vi.stubGlobal('isTauri', true);
  mockIPC(command => command === 'agent_open' ? { ...pair, source: { agent: 'b'.repeat(64), tests: 'c'.repeat(64) } } : { ...idle, state: 'complete', source: { agent: 'a'.repeat(64), tests: 'c'.repeat(64) }, report: { verdict: 'passed', cases: [{ id: 'reads-page', phase: 'Succeeded', answer: 'Earlier answer', completedTools: [], assertions: [{ id: 'contains-1', kind: 'contains', verdict: 'passed' }], verdict: 'passed' }] } });
  render(<Example />);
  expect(await screen.findByText('Earlier test verdict: passed')).toBeTruthy();
  expect(screen.queryByText('Test verdict: passed')).toBeNull();
});
test('typing autosaves without leaving the field', async () => {
  native(); const user = userEvent.setup(); render(<Example />);
  await user.click(await screen.findByRole('button', { name: 'File' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Autosaved instructions' } });
  await screen.findByText('Saved');
  await user.click(screen.getByRole('button', { name: 'Agent' }));
  expect(screen.getByText('Autosaved instructions')).toBeTruthy();
});
test.each([null, {}, { agent: 'SECRET_MARKER', tests: '', extra: 'secret' }])('malformed folder reply cannot render private data', async value => {
  vi.stubGlobal('isTauri', true); mockIPC(() => value); render(<Example />);
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(document.body.textContent).not.toContain('SECRET_MARKER');
});
test('browser preview does not fabricate a native folder', async () => {
  vi.stubGlobal('isTauri', false); const ipc = vi.fn(); mockIPC(ipc); render(<Example />);
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(ipc).not.toHaveBeenCalled();
});
