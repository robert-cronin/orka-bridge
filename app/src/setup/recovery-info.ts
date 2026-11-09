export type HelpTopic = 'virtualization' | 'hypervisor' | 'workspace';
export type RecoveryInfo = { summary: string; action: string; topic?: HelpTopic; stage: string; retryBlocked?: boolean };
const stages = ['Fill private state disk', 'Run qemu-img', 'Prepare QEMU control endpoint', 'Pin installed boot files', 'Create QEMU process', 'Open QEMU standard I/O', 'Resume QEMU process', 'Negotiate QMP', 'Check QEMU prelaunch status', 'Connect guest control', 'Start guest CPUs', 'Establish guest session'] as const;

// Recognize only native labels. In particular, a generic WHPX error does not prove
// that firmware virtualization is off or that a Windows feature is missing.
export function workspaceRecovery(detail?: string | null): RecoveryInfo {
  const text = detail ?? '';
  const stage = stages.find(value => text.includes(`${value}:`)) ?? 'Starting workspace';
  if (/Stopping the local VM failed|stopping the VM failed|startupStopFailed/.test(text)) return {
    summary: "The workspace couldn't be stopped safely.", action: 'Quit Bridge and reopen it before trying again. Your workspace may still be stopping.', topic: 'workspace', stage: 'Stopping workspace', retryBlocked: true,
  };
  if (text.includes('virtualizationDisabled')) return {
    summary: 'Virtualization is turned off on this PC.', action: "Turn it on in your PC's startup settings (often called Intel VT-x or AMD-V), restart, then press Try again.", topic: 'virtualization', stage: 'Windows virtualization',
  };
  if (text.includes('hypervisorUnavailable')) return {
    summary: "Windows Hypervisor Platform (Hyper-V) isn't available.", action: 'Turn on Windows Hypervisor Platform in Windows features, restart this PC, then press Try again.', topic: 'hypervisor', stage: 'Windows Hypervisor Platform',
  };
  if (/NoSpace|StorageFull/.test(text)) return {
    summary: "There isn't enough free space for the workspace.", action: 'Free some space on this computer, then press Try again.', topic: 'workspace', stage: 'Installing workspace files',
  };
  if (/Integrity|RetainedImage|Pin installed boot files|Image\((?:Invalid|Incompatible|Unsupported|UnsafePath)/.test(text)) return {
    summary: "The workspace files couldn't be verified.", action: 'Check that you have the matching workspace files for this Bridge build, then press Try again.', topic: 'workspace', stage: 'Checking workspace files',
  };
  if (/RetainedState|\bBusy\b/.test(text)) return {
    summary: 'The workspace files are still in use or need checking.', action: 'Close any other Bridge window, then press Try again. If it happens again, copy the details for help.', topic: 'workspace', stage: 'Checking workspace files',
  };
  if (/Orka infrastructure|InfrastructureFailed/.test(text)) return {
    summary: "The workspace's services couldn't start.", action: 'Press Try again to restart the workspace. If it happens again, copy the details for help.', stage: 'Starting workspace services',
  };
  if (/Image\(Network/.test(text)) return { summary: "The workspace files couldn't be downloaded.", action: 'Check your internet connection, then press Try again.', stage: 'Getting workspace files' };
  if (stage === 'Fill private state disk' || stage === 'Run qemu-img' || /Image\(Storage/.test(text)) return {
    summary: "The workspace files couldn't be prepared.", action: 'Press Try again to reuse the kept files. If it happens again, copy the details for help.', stage,
  };
  if (stage === 'Connect guest control' || stage === 'Establish guest session' || /Protocol\(/.test(text)) return {
    summary: "The workspace didn't finish starting.", action: 'Press Try again to restart it. If it happens again, copy the details for help.', stage,
  };
  return { summary: "The workspace couldn't start.", action: 'Press Try again to reuse the kept files. If it happens again, copy the details for help.', stage };
}

export function helpDetails(info: RecoveryInfo, detail?: string | null): string {
  // Free-form stderr, paths and messages may contain credentials. Copy only fixed
  // labels and bounded OS codes; Show details remains the local raw-error view.
  const codes = [...new Set(detail?.match(/\b(?:code: |os error )\d{1,10}\b/g) ?? [])].slice(0, 4);
  return ['Bridge workspace setup', `Stage: ${info.stage}`, info.summary, ...codes, 'Private diagnostic text is not included.'].join('\n');
}

export function modelDetails(detail: string): string {
  const marker = detail.indexOf(' Guest Connect:');
  return marker >= 0 ? detail.slice(marker + 1) : detail;
}
