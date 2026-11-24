import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SAMPLE_DOCUMENT_ID } from '../designer/agent-api';
import Home from './Home';

const other = '1b2b93c4-375c-4815-9717-39852a96e412';
const sent: { documentId: string; message?: string }[] = [];
const snapshot = (documentId: string, turns: unknown[] = []) => ({ documentId, state: 'ready', busy: false, canSend: true, versions: [{ turns }], error: null });
beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('isTauri', true);
  mockIPC((command, args) => {
    const a = args as { documentId: string; message?: string };
    if (command === 'agents_list') return [
      { id: other, name: 'inbox-summary', path: null, available: true },
      { id: SAMPLE_DOCUMENT_ID, name: 'web-reader', path: null, available: true },
      { id: '2b2b93c4-375c-4815-9717-39852a96e413', name: 'missing', path: null, available: false },
    ];
    if (command === 'agent_chat_status') return snapshot(a.documentId);
    if (command === 'agent_chat_send') { sent.push({ documentId: a.documentId, message: a.message }); return snapshot(a.documentId, [{ message: a.message, answer: null, phase: 'Running', tools: [], contextRetained: false, terminationUnconfirmed: false, stopUnconfirmed: false }]); }
    throw Error(`unexpected ${command}`);
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

test('asks web-reader by default and lists only agents whose files are available', async () => {
  render(<Home active revision={0} onOpenAgent={() => {}} onChooseWorkspace={() => {}} />);
  const picker = await screen.findByRole('combobox', { name: 'Ask' }) as HTMLSelectElement;
  expect(picker.value).toBe(SAMPLE_DOCUMENT_ID);
  expect([...picker.options].map(option => option.textContent)).toEqual(['inbox-summary', 'web-reader']);
});

test('sends the message to the chosen agent', async () => {
  const user = userEvent.setup();
  render(<Home active revision={0} onOpenAgent={() => {}} onChooseWorkspace={() => {}} />);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Ask' }), 'inbox-summary');
  const field = await screen.findByRole('textbox', { name: 'Message' });
  await user.type(field, 'What is new today?');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' }).matches(':disabled')).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(sent).toEqual([{ documentId: other, message: 'What is new today?' }]));
});

test('explains why it cannot send and links to Clusters', async () => {
  const user = userEvent.setup(); const choose = vi.fn(); const open = vi.fn();
  render(<Home active revision={0} blocked="Waiting for the workspace to start." onOpenAgent={open} onChooseWorkspace={choose} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hello');
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Send message' }).matches(':disabled')).toBe(true);
  expect(screen.getAllByText('Waiting for the workspace to start.', { exact: false }).length).toBeGreaterThan(0);
  await user.click(screen.getByRole('button', { name: 'Open Clusters' }));
  await user.click(screen.getByRole('button', { name: 'Open in Designer' }));
  expect(choose).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(SAMPLE_DOCUMENT_ID);
  expect(sent).toEqual([]);
});

test('names the page with its heading', async () => {
  render(<main aria-labelledby="page-title"><Home active revision={0} onOpenAgent={() => {}} onChooseWorkspace={() => {}} /></main>);
  expect(screen.getByRole('main', { name: 'What can Bridge do for you?' })).toBeTruthy();
});

test('an agent-specific reason blocks sending to that agent only', async () => {
  const user = userEvent.setup();
  render(<Home active revision={0} blockedFor={id => id === SAMPLE_DOCUMENT_ID ? 'Wait for your changes in Designer to save.' : undefined} onOpenAgent={() => {}} onChooseWorkspace={() => {}} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hello');
  expect(screen.getByRole('button', { name: 'Send message' }).matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Open Clusters' })).toBeNull();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Ask' }), 'inbox-summary');
  await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hello');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' }).matches(':disabled')).toBe(false));
});

test('a failed read of the agent list is not shown as having no agents, and can be retried', async () => {
  let fail = true; let reads = 0;
  mockIPC(command => {
    if (command === 'agents_list') { reads++; if (fail) throw Error('unreadable'); return [{ id: SAMPLE_DOCUMENT_ID, name: 'web-reader', path: null, available: true }]; }
    if (command === 'agent_chat_status') return snapshot(SAMPLE_DOCUMENT_ID);
    throw Error('unexpected');
  });
  const user = userEvent.setup();
  render(<Home active revision={0} onOpenAgent={() => {}} onChooseWorkspace={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toContain('couldn’t read your agents');
  expect(screen.queryByText(/no agents yet/)).toBeNull();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('combobox', { name: 'Ask' })).toBeTruthy();
  expect(reads).toBe(2);
});

test('adding Bridge’s assistant selects it even after another agent was chosen', async () => {
  const user = userEvent.setup(); let revision = 0;
  const added = '4b2b93c4-375c-4815-9717-39852a96e414';
  const view = render(<Home active revision={revision} onOpenAgent={() => {}} onChooseWorkspace={() => {}} onAddAssistant={() => {}} />);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Ask' }), 'inbox-summary');
  await user.click(screen.getByRole('button', { name: 'Add Bridge’s assistant' }));
  mockIPC((command, args) => {
    if (command === 'agents_list') return [{ id: other, name: 'inbox-summary', path: null, available: true }, { id: added, name: 'bridge-assistant', path: null, available: true }];
    if (command === 'agent_chat_status') return snapshot((args as { documentId: string }).documentId);
    throw Error(`unexpected ${command}`);
  });
  revision++;
  view.rerender(<Home active revision={revision} preferred={added} onOpenAgent={() => {}} onChooseWorkspace={() => {}} onAddAssistant={() => {}} />);
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Ask' }) as HTMLSelectElement).value).toBe(added));
  expect(screen.getByText('Ask Bridge below. Answers come from your workspace on this computer.').getAttribute('role')).toBe('status');
});

test('while the assistant is being set up, the wait is announced and nothing else is offered', async () => {
  render(<Home active revision={0} assistantBusy onOpenAgent={() => {}} onChooseWorkspace={() => {}} onAddAssistant={() => {}} />);
  expect((await screen.findByText('Setting up Bridge’s assistant…')).getAttribute('role')).toBe('status');
  expect(screen.queryByRole('button', { name: 'Add Bridge’s assistant' })).toBeNull();
});
