import { type AssistantFailure, assistantFailureCopy } from './assistant';

// Home's Next card: one sentence on where things stand and, at most, one thing to do now.
// States are checked in order, so the first that applies wins; each names its action, not its label.
export type HomeAction = 'retryList' | 'assistant' | 'clusters' | 'designer';
export type HomeNext = { line: string; action?: HomeAction; tone: 'info' | 'busy' | 'error' };
export type HomeState = {
  listFailed: boolean; assistantBusy: boolean; assistantError?: AssistantFailure; placeBlocked?: string;
  chosen?: { label: string }; agentBlocked?: string; hasAssistant: boolean; canAddAssistant: boolean;
};
export function homeNext(s: HomeState): HomeNext {
  if (s.listFailed) return { line: 'Bridge couldn’t read your agents.', action: 'retryList', tone: 'error' };
  if (s.assistantBusy) return { line: 'Setting up Bridge’s assistant…', tone: 'busy' };
  if (s.assistantError) return { line: `Bridge’s assistant couldn’t be set up. ${assistantFailureCopy[s.assistantError]}`, action: s.canAddAssistant ? 'assistant' : undefined, tone: 'error' };
  if (s.placeBlocked) return { line: s.placeBlocked, action: 'clusters', tone: 'info' };
  if (!s.chosen) return s.canAddAssistant ? { line: 'You have no agents yet. Chat with Bridge, or create your own agent in Designer.', action: 'assistant', tone: 'info' }
    : { line: 'You have no agents yet. Create one in Designer.', tone: 'info' };
  if (s.agentBlocked) return { line: s.agentBlocked, action: 'designer', tone: 'info' };
  if (!s.hasAssistant && s.canAddAssistant) return { line: `Ask ${s.chosen.label} below, or add Bridge’s assistant for everyday questions.`, action: 'assistant', tone: 'info' };
  return { line: `Ask ${s.chosen.label} below. Answers come from your workspace on this computer.`, tone: 'info' };
}
