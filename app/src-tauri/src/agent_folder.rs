//! One native-owned document. Paths are outbound display data, never write inputs.
use crate::runtime::snapshot::{AgentDocument, Snapshot};
use bridge_runtime_protocol::{FileSlot, SnapshotId, Uuid, MAX_FILE};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, MetadataExt, OpenOptions};
use std::{
    io::{self, Read, Seek, Write},
    path::PathBuf,
    sync::Mutex,
};
#[path = "agent_folder_git.rs"]
mod git;
const AGENT: &str = "web-reader.agent.md";
const TESTS: &str = "web-reader.agent.test.md";
const MARKER: &str = ".bridge-agent-folder";
const OWNER: &[u8] = b"Bridge web-reader folder v1\n";
type Result<T> = std::result::Result<T, &'static str>;
#[derive(serde::Serialize)]
pub struct AgentPair {
    pub agent: String,
    pub tests: String,
    pub source: SnapshotId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}
pub struct AgentFolder {
    home: Option<PathBuf>,
    lock: Mutex<()>,
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
fn child(parent: &Dir, name: &str) -> io::Result<Dir> {
    match parent.create_dir(name) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e),
    }
    let directory = parent.open_dir_nofollow(name)?;
    sync(parent)?; // Also retry a prior mkdir's failed parent flush.
    Ok(directory)
}
fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    options
}
fn regular(file: &File) -> io::Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(invalid());
    }
    #[cfg(unix)]
    if meta.nlink() != 1 {
        return Err(invalid());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.nNumberOfLinks != 1 || meta.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
    }
    Ok(())
}
fn read(dir: &Dir, name: &str, limit: usize) -> io::Result<Vec<u8>> {
    let file = dir.open_with(name, &options())?;
    regular(&file)?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid());
    }
    Ok(bytes)
}
fn sync(dir: &Dir) -> io::Result<()> {
    #[cfg(unix)]
    let file = dir.open(".")?;
    #[cfg(windows)]
    let file = {
        use cap_std::fs::OpenOptionsExt;
        let mut opts = options();
        opts.write(true)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS);
        dir.open_with(".", &opts)?
    };
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // Apple full-file flush is for regular files, not directory namespaces.
        if unsafe { libc::fsync(file.as_raw_fd()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(windows)]
    file.sync_all()
}
// All destinations are fixed single leaves on retained no-follow capabilities.
// A fresh inode + rename cannot truncate a hardlinked or symlinked destination.
fn replace(dir: &Dir, name: &str, bytes: &[u8]) -> io::Result<()> {
    let temp = format!(".bridge-{}", Uuid::new_v4());
    let mut options = options();
    options.write(true).create_new(true);
    let mut file = dir.open_with(&temp, &options)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        dir.rename(&temp, dir, name)?;
        sync(dir)
    })();
    if result.is_err() {
        let _ = dir.remove_file(&temp);
    }
    result
}
impl AgentFolder {
    pub fn new(home: Option<PathBuf>) -> Self {
        Self {
            home,
            lock: Mutex::new(()),
        }
    }
    fn with<T>(&self, work: impl FnOnce(&Dir) -> io::Result<T>) -> Result<T> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "The local agent folder is unavailable.")?;
        let operation = || -> io::Result<T> {
            let home = self.home.as_ref().ok_or_else(invalid)?;
            if std::fs::symlink_metadata(home)?.file_type().is_symlink() {
                return Err(invalid());
            }
            let home = Dir::open_ambient_dir(home, cap_std::ambient_authority())?;
            let agents = child(&child(&home, "Orka")?, "agents")?;
            let created = match agents.create_dir("web-reader") {
                Ok(()) => true,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
                Err(e) => return Err(e),
            };
            let root = agents.open_dir_nofollow("web-reader")?;
            let mut opts = options();
            opts.write(true).create_new(created);
            let marker = root.open_with(MARKER, &opts)?;
            regular(&marker)?;
            let mut marker = marker.into_std();
            // Also serializes other native owners/processes. Never wait on renderer work.
            marker.lock()?;
            if created {
                marker.write_all(OWNER)?;
                marker.sync_all()?;
                replace(
                    &root,
                    AGENT,
                    include_bytes!("../example-agent/web-reader.agent.md"),
                )?;
                replace(
                    &root,
                    TESTS,
                    include_bytes!("../example-agent/web-reader.agent.test.md"),
                )?;
                let git = child(&root, ".git")?;
                child(&git, "objects")?;
                child(&git, "refs")?;
                let info = child(&git, "info")?;
                replace(&info, "exclude", b"/.bridge-agent-folder\n")?;
                replace(
                    &git,
                    "config",
                    b"[core]\nrepositoryformatversion = 0\nbare = false\n",
                )?;
                replace(&git, "HEAD", b"")?;
                sync(&root)?;
            } else {
                marker.rewind()?;
                let mut ownership = Vec::new();
                (&mut marker)
                    .take(OWNER.len() as u64 + 1)
                    .read_to_end(&mut ownership)?;
                if ownership != OWNER {
                    return Err(invalid());
                }
            }
            sync(&agents)?;
            // Retry a prior working-file rename's failed namespace flush even
            // when the visible bytes already match the next save/open.
            sync(&root)?;
            work(&root)
        };
        operation().map_err(|_| "The local agent folder could not be read or saved. Check that it is a Bridge-managed folder with regular files, then retry.")
    }
    fn display_path(&self) -> Option<String> {
        self.home.as_ref().and_then(|home| {
            home.join("Orka")
                .join("agents")
                .join("web-reader")
                .join(AGENT)
                .to_str()
                .map(str::to_owned)
        })
    }
    fn pair(&self, root: &Dir) -> io::Result<AgentPair> {
        let agent = String::from_utf8(read(root, AGENT, MAX_FILE)?).map_err(|_| invalid())?;
        let tests = String::from_utf8(read(root, TESTS, MAX_FILE)?).map_err(|_| invalid())?;
        let source = SnapshotId::of(agent.as_bytes(), tests.as_bytes());
        Ok(AgentPair {
            agent,
            tests,
            source,
            path: self.display_path(),
        })
    }
    pub fn open(&self) -> Result<AgentPair> {
        self.with(|root| {
            let pair = self.pair(root)?;
            git::commit(root, &pair)?; // Dirty reopen is committed, never silently reported Saved.
            Ok(pair)
        })
    }
    pub fn save(&self, content: String) -> Result<AgentPair> {
        if content.len() > MAX_FILE {
            return Err("The agent file is too large to save.");
        }
        self.with(|root| {
            let mut pair = self.pair(root)?;
            git::validate(root)?;
            if pair.agent != content {
                // Preserve edits from another editor before replacing the disk version.
                git::commit(root, &pair)?;
                replace(root, AGENT, content.as_bytes())?;
                pair.agent = content;
                pair.source = SnapshotId::of(pair.agent.as_bytes(), pair.tests.as_bytes());
            }
            git::commit(root, &pair)?; // Failure leaves draft bytes; retry reconciles disk with HEAD.
            Ok(pair)
        })
    }
    /// Trusted native Send seam only; never exposed through IPC.
    pub fn source(&self) -> Result<(PathBuf, AgentDocument)> {
        self.open()?;
        Ok((
            self.home.as_ref().unwrap().join("Orka/agents/web-reader"),
            AgentDocument {
                agent: AGENT.into(),
                tests: TESTS.into(),
            },
        ))
    }
    pub fn capture(&self) -> Result<Snapshot> {
        self.with(|root| {
            let pair = self.pair(root)?;
            git::commit(root, &pair)?;
            let snapshot = Snapshot::capture_dir(
                root,
                &AgentDocument {
                    agent: AGENT.into(),
                    tests: TESTS.into(),
                },
            )?;
            if snapshot.file(FileSlot::Agent) != pair.agent.as_bytes()
                || snapshot.file(FileSlot::Tests) != pair.tests.as_bytes()
            {
                return Err(invalid());
            }
            Ok(snapshot)
        })
    }
}

#[cfg(all(test, unix))]
mod display_path_tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn unrepresentable_display_path_is_omitted() {
        // Test the projection itself: APFS cannot create a non-UTF-8 directory.
        let home = std::ffi::OsStr::from_bytes(b"/creator-\xff");
        assert!(AgentFolder::new(Some(home.into())).display_path().is_none());
    }
}
