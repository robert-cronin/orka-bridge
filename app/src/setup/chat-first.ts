// Set when someone chooses one-click setup on Welcome. It replaces the example agent's
// automatic first test with a chat with Bridge, and is consumed when that chat opens.
export const chatFirstPreference = 'bridge.chatFirst.v1';
export function armChatFirst() {
  try { localStorage.setItem(chatFirstPreference, 'pending'); } catch { /* Without storage, setup still starts; Bridge just doesn't open Home by itself. */ }
}
export function chatFirstPending() {
  try { return localStorage.getItem(chatFirstPreference) === 'pending'; } catch { return false; }
}
export function chatFirstChosen() {
  try { return localStorage.getItem(chatFirstPreference) !== null; } catch { return false; }
}
// Finished chat-first setup is a returning session, the way an attempted first test is for the step-by-step path.
export function chatFirstDone() {
  try { return localStorage.getItem(chatFirstPreference) === 'done'; } catch { return false; }
}
export function finishChatFirst() {
  try { if (localStorage.getItem(chatFirstPreference) === 'pending') localStorage.setItem(chatFirstPreference, 'done'); } catch { /* Nothing else depends on it. */ }
}
