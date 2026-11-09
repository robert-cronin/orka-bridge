//! Read-only post-boot infrastructure observation, separate from storage readiness.
use crate::{early::invalid, linux::read_regular};
use bridge_runtime_protocol::*;
use serde::Deserialize;
use std::{io, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    schema_version: String,
    installation_id: Uuid,
    phase: BootstrapPhase,
    input_identity: String,
    node_ids: Vec<String>,
}
pub(crate) fn observe(
    path: &Path,
    installation: Uuid,
    unit: &[u8],
) -> io::Result<InfrastructureState> {
    let phase = match read_regular(path, 4096) {
        Ok(bytes) => {
            let journal: Bootstrap = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if journal.schema_version != "bridge-infrastructure/v1"
                || journal.installation_id != installation
                || journal.input_identity.is_empty()
                || journal
                    .node_ids
                    .iter()
                    .any(|id| id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
                || (journal.node_ids.is_empty()
                    && journal.phase != BootstrapPhase::IdentityPrepared)
            {
                return Err(invalid());
            }
            Some(journal.phase)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let text = std::str::from_utf8(unit).map_err(|_| invalid())?;
    let fields = text
        .lines()
        .filter_map(|s| s.split_once('='))
        .collect::<Vec<_>>();
    let field = |key| -> io::Result<&str> {
        let mut values = fields.iter().filter(|(k, _)| *k == key).map(|(_, v)| *v);
        let value = values.next().ok_or_else(invalid)?;
        if values.next().is_some() {
            return Err(invalid());
        }
        Ok(value)
    };
    let (load, active, sub, result, job) = (
        field("LoadState")?,
        field("ActiveState")?,
        field("SubState")?,
        field("Result")?,
        field("Job")?,
    );
    let service = match (load, active, sub, result) {
        ("loaded", "active", "exited", "success") => InfrastructureService::Ready,
        ("loaded", "activating", _, _) => InfrastructureService::Starting,
        // The unit is ordered after the guest. Its queued start is not a failure.
        ("loaded", "inactive", _, "success") if job.parse::<u32>().is_ok_and(|id| id != 0) => {
            InfrastructureService::Starting
        }
        _ => InfrastructureService::Failed,
    };
    Ok(InfrastructureState { phase, service })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const ACTIVE: &[u8] =
        b"LoadState=loaded\nActiveState=active\nSubState=exited\nResult=success\nJob=\n";
    const STARTING: &[u8] =
        b"LoadState=loaded\nActiveState=activating\nSubState=start\nResult=success\nJob=42\n";
    fn journal(path: &Path, id: Uuid, phase: &str) {
        fs::write(
            path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": "bridge-infrastructure/v1", "installationId": id,
                "inputIdentity": "a".repeat(64), "phase": phase, "nodeIds": ["b".repeat(64)]
            }))
            .unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn current_unit_completion_not_a_stale_journal_controls_readiness() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bootstrap.json");
        let id = Uuid::new_v4();
        assert_eq!(
            observe(&path, id, STARTING).unwrap().service,
            InfrastructureService::Starting
        );
        for phase in [
            "identity-prepared",
            "cluster-ready",
            "cache-verified",
            "orka-ready",
            "infrastructure-ready",
        ] {
            journal(&path, id, phase);
            let state = observe(&path, id, STARTING).unwrap();
            assert_eq!(state.service, InfrastructureService::Starting);
            assert!(state.phase.is_some());
        }
        assert_eq!(
            observe(&path, id, ACTIVE).unwrap(),
            InfrastructureState {
                phase: Some(BootstrapPhase::InfrastructureReady),
                service: InfrastructureService::Ready,
            }
        );
        for (unit, expected) in [
            (
                "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nJob=42\n",
                InfrastructureService::Starting,
            ),
            (
                "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nJob=\n",
                InfrastructureService::Failed,
            ),
            (
                "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nJob=\n",
                InfrastructureService::Failed,
            ),
            (
                "LoadState=masked\nActiveState=inactive\nSubState=dead\nResult=success\nJob=\n",
                InfrastructureService::Failed,
            ),
            (
                "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\nJob=\n",
                InfrastructureService::Failed,
            ),
        ] {
            assert_eq!(
                observe(&path, id, unit.as_bytes()).unwrap().service,
                expected
            );
        }
    }
    #[test]
    fn foreign_malformed_or_unsafe_journals_never_prove_readiness() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bootstrap.json");
        let id = Uuid::new_v4();
        journal(&path, Uuid::new_v4(), "infrastructure-ready");
        assert!(observe(&path, id, ACTIVE).is_err());
        for bytes in [b"{}".to_vec(), vec![b' '; 4097]] {
            fs::write(&path, bytes).unwrap();
            assert!(observe(&path, id, STARTING).is_err());
        }
        fs::remove_file(&path).unwrap();
        let target = temp.path().join("other");
        journal(&target, id, "infrastructure-ready");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(observe(&path, id, ACTIVE).is_err());
        assert!(observe(&target, id, b"ActiveState=active\n").is_err());
    }
}
