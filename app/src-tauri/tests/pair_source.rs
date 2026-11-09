use bridge_engine::{
    agent_folder::AgentFolder,
    pair_source::{CapturedPair, PairCatalog},
};
use bridge_runtime_protocol::FileSlot;

// Reverting to embedded bytes or recapturing on access would break these checks.
#[test]
fn owned_folder_disk_not_embedded_pair() {
    let home = tempfile::tempdir().unwrap();
    let folder = AgentFolder::new(Some(home.path().into()));
    let opened = folder.open().unwrap();
    let edited = opened.agent.replace(
        "Answer from the web page named in the request.",
        "Use my saved instructions.",
    );
    folder.save(edited.clone()).unwrap();
    let (root, document) = folder.source().unwrap();
    let catalog = PairCatalog::default();
    let id = catalog.bind_owned_agent(root.clone(), document).unwrap();
    let captured = catalog.capture(id).unwrap();
    assert_eq!(captured.snapshot().file(FileSlot::Agent), edited.as_bytes());
    assert!(captured
        .pair()
        .prompt()
        .contains("Use my saved instructions."));
    std::fs::remove_file(root.join("web-reader.agent.md")).unwrap();
    assert!(
        catalog.capture(id).is_err(),
        "missing owned file must not fall back to the example"
    );
    assert_eq!(captured.snapshot().file(FileSlot::Agent), edited.as_bytes());
}

#[test]
fn edit_changes_both_hash_association() {
    let home = tempfile::tempdir().unwrap();
    let folder = AgentFolder::new(Some(home.path().into()));
    folder.open().unwrap();
    let (root, document) = folder.source().unwrap();
    let catalog = PairCatalog::default();
    let id = catalog.bind_owned_agent(root.clone(), document).unwrap();
    let before = catalog.capture(id).unwrap();
    let agent = String::from_utf8(before.snapshot().file(FileSlot::Agent).to_vec()).unwrap();
    let tests = String::from_utf8(before.snapshot().file(FileSlot::Tests).to_vec()).unwrap();
    std::fs::write(root.join("web-reader.agent.md"), format!("{agent}\n")).unwrap();
    std::fs::write(root.join("web-reader.agent.test.md"), format!("{tests}\n")).unwrap();
    let after = catalog.capture(id).unwrap();
    assert_ne!(before.snapshot().id().agent, after.snapshot().id().agent);
    assert_ne!(before.snapshot().id().tests, after.snapshot().id().tests);
    assert_eq!(after.pair().snapshot(), &after.snapshot().id());
    assert_eq!(before.pair().snapshot(), &before.snapshot().id());
    let owner_capture = CapturedPair::from_snapshot(folder.capture().unwrap()).unwrap();
    assert_eq!(owner_capture.pair().snapshot(), after.pair().snapshot());
    assert!(PairCatalog::default().capture(id).is_err());
}

#[test]
fn malformed_pair_has_no_capture_and_relative_escape_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let folder = AgentFolder::new(Some(home.path().into()));
    folder.open().unwrap();
    let (root, document) = folder.source().unwrap();
    let catalog = PairCatalog::default();
    let id = catalog.bind_owned_agent(root.clone(), document).unwrap();
    std::fs::write(root.join("web-reader.agent.md"), "unfinished").unwrap();
    assert!(catalog.capture(id).is_err());
    let document = bridge_engine::runtime::snapshot::AgentDocument {
        agent: "../outside".into(),
        tests: "web-reader.agent.test.md".into(),
    };
    assert!(catalog.bind_owned_agent(root, document).is_err());
}

#[cfg(unix)]
#[test]
fn bound_root_or_ancestor_replacement_cannot_redirect_capture() {
    for replace_ancestor in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let folder = AgentFolder::new(Some(home.path().into()));
        let original = folder.open().unwrap().agent;
        let (root, document) = folder.source().unwrap();
        let catalog = PairCatalog::default();
        let id = catalog.bind_owned_agent(root.clone(), document).unwrap();
        let other_home = tempfile::tempdir().unwrap();
        let other = AgentFolder::new(Some(other_home.path().into()));
        other
            .save(original.replace(
                "Answer from the web page named in the request.",
                "Different directory.",
            ))
            .unwrap();
        let (other_root, _) = other.source().unwrap();
        let target = if replace_ancestor {
            root.parent().unwrap()
        } else {
            root.as_path()
        };
        let replacement = if replace_ancestor {
            other_root.parent().unwrap()
        } else {
            other_root.as_path()
        };
        std::fs::rename(target, target.with_extension("retained")).unwrap();
        std::os::unix::fs::symlink(replacement, target).unwrap();
        let captured = catalog.capture(id).unwrap();
        assert_eq!(
            captured.snapshot().file(FileSlot::Agent),
            original.as_bytes()
        );
    }
}

#[cfg(unix)]
#[test]
fn capture_does_not_follow_document_symlinks() {
    let home = tempfile::tempdir().unwrap();
    let folder = AgentFolder::new(Some(home.path().into()));
    let original = folder.open().unwrap().agent;
    let (root, document) = folder.source().unwrap();
    let catalog = PairCatalog::default();
    let id = catalog.bind_owned_agent(root.clone(), document).unwrap();
    let outside = home.path().join("outside");
    std::fs::write(&outside, original).unwrap();
    std::fs::remove_file(root.join("web-reader.agent.md")).unwrap();
    std::os::unix::fs::symlink(outside, root.join("web-reader.agent.md")).unwrap();
    assert!(catalog.capture(id).is_err());
}
