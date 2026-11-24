# Release install checklist

Use this checklist to install a Bridge release from its GitHub Release assets on a machine that has never run Bridge, and to record what happened. It checks the release, not a development build. [Try the Bridge local preview](preview.md) has the install steps themselves; this page adds what to verify and what to log at each step.

Do one run per platform: Windows x64 and Apple-silicon Mac. Copy the log template at the end and fill it in as you go. Where **Verify** asks a question, record the answer; a no is a finding, not a failed run. Don't change system protections to get past a step: record the block and stop.

## Before you start: a clean machine

A clean machine has no Bridge state. Before installing, confirm and log that none of these exist:

- Windows: `%LOCALAPPDATA%\ai.orka.bridge`, `%APPDATA%\ai.orka.bridge`, and any earlier extracted Bridge folder.
- Mac: `~/Library/Application Support/ai.orka.bridge` and any `Bridge.app`.
- Both: `Orka/agents` in your home folder. If it exists from other work, note it rather than deleting it.
- Both: a saved Bridge sign-in in the OS credential store (Windows Credential Manager, or the Mac keychain). Search for `Bridge`.

Then record the machine:

- OS name, version and build; CPU model; installed RAM.
- Free space on the drive holding your user profile. [Disk space](preview.md#disk-space) lists the budget.
- Windows: whether hardware virtualization and **Windows Hypervisor Platform** are on, and the WebView2 Runtime version.
- GitHub CLI: installed or not, its version, and `gh auth status --hostname github.com` (account name only, never the token).

## Steps

| # | Do | Verify | Log |
|---|---|---|---|
| 1 | Open the release by its exact tag on [Bridge releases](https://github.com/orka-agents/orka-bridge/releases). | It's the app release, not a **Bridge VM images** release. It's marked pre-release or latest as expected. | Tag, release title, pre-release or latest, the asset list with sizes. |
| 2 | Download `bridge-windows-x64.zip` or `bridge-macos-arm64.tar.gz`. The Windows runtime source archive isn't needed to run Bridge. | Size matches the release page. If the release lists checksums, they match. | Download time, and the SHA-256 you compute: `Get-FileHash -Algorithm SHA256 <file>` on Windows, `shasum -a 256 <file>` on Mac. Say whether the release lists a checksum to compare with. |
| 3 | Extract and place the app as [Open the app](preview.md#open-the-app) describes. | Windows: the whole folder is kept, including `native\qemu` and the notices. Mac: `Bridge.app` is in an Applications folder. | Where it was extracted, and the extracted size. |
| 4 | Check the app's signature before opening it. | Record the result; a preview may be unsigned. | Windows: `Get-AuthenticodeSignature .\orka-bridge.exe` status and signer. Mac: `codesign -dv --verbose=2 Bridge.app` and `spctl --assess --type execute -vv Bridge.app` output, plus `LSMinimumSystemVersion` from `Bridge.app/Contents/Info.plist`. |
| 5 | Open the app. | Any SmartScreen or Gatekeeper prompt offers the documented exception. Bridge opens on its welcome page. | Every prompt's exact wording and a screenshot, and the path taken (**Run anyway**, **Open Anyway**). If no exception was offered, stop and report. Don't remove quarantine or disable protection. |
| 6 | Read the welcome page before choosing anything. | Does it say what setup needs (free disk, download, memory) before anything starts? | The figures it shows, and whether they match [Disk space](preview.md#disk-space) and your machine. |
| 7 | Start setup on this computer. | Does the computer check run, and does each blocker name an action? Does anything download before you confirm? | Each check result, and the time setup starts. |
| 8 | Wait for the workspace to be ready. Leave Bridge open. | Does progress keep moving and say what it's doing? Is Cancel offered? | Start and end time of each stage the app shows, total time to ready, and any retry. Images download anonymously; note any sign-in prompt during this step as a problem. |
| 9 | Measure the installed footprint once ready. | Nothing outside the app-data folder and `Orka/agents` changed. | Size of the app-data folder (`local-vm-v1`, `image-cache-v1`) and free space left. Optional: the VM process's memory just after start and a few minutes later. |
| 10 | Connect the AI. | Before using a sign-in, does Bridge say which one and what is shared? Does the connection reach **Connected**? | The route chosen (GitHub Copilot or your own key), the wording shown before connecting, time to connect, and any error with **Copy details for help** output. |
| 11 | Ask the AI something, then run the example agent's test as [Set up and run the example](preview.md#set-up-and-run-the-example) describes. | An answer arrives; the example's test passes and its **Tools used** includes `web_fetch`. | The question and whether it was answered, the test result, and the time each took. |
| 12 | Close the window while the workspace runs. | Bridge explains that it keeps running, then hides to the tray or menu bar. | The notice's wording, and that the tray or menu-bar icon offers **Open Bridge** and **Quit Bridge**. |
| 13 | Choose **Quit Bridge**, then reopen the app. | Quitting finishes, with no Bridge or VM process left. On reopening, the workspace starts again without a new download. | Time to quit, any process left running, time from reopening to ready. |
| 14 | Remove Bridge as [Remove Bridge](preview.md#remove-bridge) describes. | **Remove sign-in** confirms, and the listed folders and the saved sign-in are gone. | Each removal step's result, and anything left behind (folders, credential-store entries, processes). |

## What to log, and what not to

Log these:

- The machine record and the release record (tag, assets, sizes, your computed SHA-256s).
- For every step: done, blocked or failed, with a timestamp.
- Exact wording of every prompt and error, with screenshots.
- **Copy details for help** output where offered.

Never log these:

- Tokens, keys or the output of `gh auth token`.
- VM disks, a whole app-data folder, or private agent content.
- Personal paths beyond what a step asks for.

Report results through [Report a problem](preview.md#report-a-problem), one report per run.

## Log template

```text
Release: <tag> (<pre-release|latest>)   Date: <YYYY-MM-DD>   Tester: <name or handle>
Machine: <OS + version/build>, <CPU>, <RAM>, <free disk on profile drive>
Virtualization: <on/off; Windows Hypervisor Platform on/off>   WebView2: <version or n/a>
GitHub CLI: <not installed | version, signed in as <account>>
Clean machine: <yes | what existed>

Asset: <name> <size>  SHA-256: <hash>  Release lists checksum: <yes/no; match?>
Signature: <result of step 4>

Step | Result | Time | Notes
1    |        |      |
...
14   |        |      |

Footprint when ready: app data <size>, free disk left <size>
Problems: <one line each, with screenshot names>
```
