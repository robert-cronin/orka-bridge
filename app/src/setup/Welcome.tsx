import { Button } from '../components/Button';
import mark from '../assets/orka-mark.svg';
import { formatRequirementGB, type WorkspaceRequirements } from './requirements';

export const welcomePreference = 'bridge.welcomeSeen.v1';
export function hasSeenWelcome() {
  try { return localStorage.getItem(welcomePreference) === '1'; }
  catch { return false; }
}

// One click sets up this computer and leads to a chat with Bridge. Choosing the place, or
// starting from the example agent, stays available as the step-by-step path.
export default function Welcome({ titleId, onStart, onStepByStep, onCluster, unavailable, requirements }: {
  titleId?: string; onStart: () => void; onStepByStep: () => void; onCluster: () => void; unavailable?: string; requirements?: WorkspaceRequirements | null;
}) {
  const cost = requirements ? `Needs about ${formatRequirementGB(requirements.freeDiskBytes)} of free disk space${requirements.downloadBytes !== null ? `, downloads about ${formatRequirementGB(requirements.downloadBytes)},` : ''} and uses ${formatRequirementGB(requirements.memoryBytes)} of memory while it runs.` : undefined;
  return <section className="welcome-screen">
    <img className="welcome-mark" src={mark} width="44" height="44" alt="" />
    <h1 id={titleId}>Chat with Bridge, then build your own agents</h1>
    <p className="welcome-lede">Bridge sets up a private workspace on this computer and connects it to an AI. No Kubernetes needed.</p>
    <ol className="welcome-journey">
      <li><span className="journey-number" aria-hidden="true">1</span><b>Set up</b><span>One click. Bridge downloads and starts your workspace.</span></li>
      <li><span className="journey-number" aria-hidden="true">2</span><b>Connect the AI</b><span>Use GitHub Copilot or your own key.</span></li>
      <li><span className="journey-number" aria-hidden="true">3</span><b>Chat</b><span>Ask Bridge anything. Make your own agents when you’re ready.</span></li>
    </ol>
    <div className="welcome-actions">
      <Button kind="primary" type="button" disabled={!!unavailable} onClick={onStart}>Set up Bridge</Button>
      <span className="muted">About 5 minutes, mostly a download</span>
      {cost && !unavailable && <p className="muted">{cost}</p>}
      {unavailable && <p className="muted">{unavailable}</p>}
    </div>
    <div className="welcome-other">
      <Button kind="quiet" type="button" className="welcome-expert" onClick={onStepByStep}>Set up step by step</Button>
      <Button kind="quiet" type="button" className="welcome-expert" onClick={onCluster}>I already run Orka on a cluster</Button>
    </div>
  </section>;
}
