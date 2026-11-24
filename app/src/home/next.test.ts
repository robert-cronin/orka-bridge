import { expect, test } from 'vitest';
import { type HomeState, homeNext } from './next';

const ready: HomeState = { listFailed: false, assistantBusy: false, chosen: { label: 'Bridge' }, hasAssistant: true, canAddAssistant: true };
test('a ready Home says what to do now, with no action to take first', () => {
  expect(homeNext(ready)).toEqual({ line: 'Ask Bridge below. Answers come from your workspace on this computer.', tone: 'info' });
});
test('the first state that needs the person wins, each with at most one action', () => {
  expect(homeNext({ ...ready, listFailed: true, placeBlocked: 'Waiting.' })).toMatchObject({ action: 'retryList', tone: 'error' });
  expect(homeNext({ ...ready, assistantBusy: true, assistantError: 'x' })).toEqual({ line: 'Setting up Bridge’s assistant…', tone: 'busy' });
  expect(homeNext({ ...ready, assistantError: 'lost', placeBlocked: 'Waiting.' })).toMatchObject({ action: 'assistant', tone: 'error' });
  expect(homeNext({ ...ready, placeBlocked: 'Connect the AI in Clusters before chatting.', agentBlocked: 'Save first.' })).toEqual({ line: 'Connect the AI in Clusters before chatting.', action: 'clusters', tone: 'info' });
  expect(homeNext({ ...ready, agentBlocked: 'Save your edits first.' })).toMatchObject({ action: 'designer' });
  expect(homeNext({ ...ready, chosen: { label: 'web-reader' }, hasAssistant: false })).toMatchObject({ action: 'assistant', line: expect.stringContaining('web-reader') });
});
test('without a way to add the assistant, Home never offers it', () => {
  expect(homeNext({ ...ready, chosen: undefined, hasAssistant: false, canAddAssistant: false })).toEqual({ line: 'You have no agents yet. Create one in Designer.', tone: 'info' });
  expect(homeNext({ ...ready, hasAssistant: false, canAddAssistant: false }).action).toBeUndefined();
  expect(homeNext({ ...ready, assistantError: 'lost', canAddAssistant: false }).action).toBeUndefined();
});
