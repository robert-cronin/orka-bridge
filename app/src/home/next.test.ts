import { expect, test } from 'vitest';
import { type HomeState, homeNext } from './next';

const ready: HomeState = { listFailed: false, assistantBusy: false, chosen: { label: 'Bridge' }, hasAssistant: true, canAddAssistant: true };
test('a ready Home says what to do now, with no action to take first', () => {
  expect(homeNext(ready)).toEqual({ line: 'Ask Bridge below. Answers come from your workspace on this computer.', tone: 'info' });
});
test('the first state that needs the person wins, each with at most one action', () => {
  expect(homeNext({ ...ready, listFailed: true, placeBlocked: 'Waiting.' })).toMatchObject({ action: 'retryList', tone: 'error' });
  expect(homeNext({ ...ready, assistantBusy: true, assistantError: 'notSaved' })).toEqual({ line: 'Setting up Bridge’s assistant…', tone: 'busy' });
  expect(homeNext({ ...ready, assistantError: 'notSaved', placeBlocked: 'Waiting.' })).toMatchObject({ action: 'assistant', tone: 'error' });
  expect(homeNext({ ...ready, placeBlocked: 'Connect the AI in Clusters before chatting.', agentBlocked: 'Save first.' })).toEqual({ line: 'Connect the AI in Clusters before chatting.', action: 'clusters', tone: 'info' });
  expect(homeNext({ ...ready, agentBlocked: 'Save your edits first.' })).toMatchObject({ action: 'designer' });
  expect(homeNext({ ...ready, chosen: { label: 'web-reader' }, hasAssistant: false })).toMatchObject({ action: 'assistant', line: expect.stringContaining('web-reader') });
});
test('without a way to add the assistant, Home never offers it', () => {
  expect(homeNext({ ...ready, chosen: undefined, hasAssistant: false, canAddAssistant: false })).toEqual({ line: 'You have no agents yet. Create one in Designer.', tone: 'info' });
  expect(homeNext({ ...ready, hasAssistant: false, canAddAssistant: false }).action).toBeUndefined();
  expect(homeNext({ ...ready, assistantError: 'notSaved', canAddAssistant: false }).action).toBeUndefined();
});
test('an assistant failure is a finite kind with one sentence each', () => {
  expect(homeNext({ ...ready, assistantError: 'listUnreadable' }).line).toBe('Bridge’s assistant couldn’t be set up. Bridge couldn’t read your agents.');
  expect(homeNext({ ...ready, assistantError: 'fileUnavailable' }).line).toBe('Bridge’s assistant couldn’t be set up. Its file couldn’t be opened. Check it in Designer.');
});
