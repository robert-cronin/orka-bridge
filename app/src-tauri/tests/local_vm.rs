use bridge_engine::{
    engine::{types::*, EngineState, EngineTransport, TransportFuture},
    local_vm::{LocalFactory, LocalSession, LocalVm, LocalVmStatus, StartFuture},
    runtime::types::RuntimeError,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use tokio::sync::{watch, Notify};

#[derive(Default)]
struct Probe {
    starts: AtomicUsize,
    stops: AtomicUsize,
    launch: Notify,
    entered: Notify,
    io: (Mutex<bool>, Condvar),
    order: Mutex<Vec<&'static str>>,
    fail_stop: bool,
    fail_launch: bool,
}
struct Factory(Arc<Probe>);
struct Session(Arc<Probe>);
impl LocalFactory for Factory {
    fn launch(
        &self,
        _: watch::Receiver<bool>,
        progress: Arc<dyn Fn(bridge_engine::local_vm::LocalProgress) + Send + Sync>,
    ) -> StartFuture<'_> {
        let p = self.0.clone();
        Box::pin(async move {
            p.starts.fetch_add(1, Ordering::SeqCst);
            progress(bridge_engine::local_vm::LocalProgress::Status(
                LocalVmStatus::Installing,
            ));
            progress(bridge_engine::local_vm::LocalProgress::Image(
                bridge_engine::runtime::image_types::ImageProgress::Retained {
                    bytes: 800,
                    total: 1000,
                },
            ));
            p.launch.notified().await;
            if p.fail_launch {
                return Err(RuntimeError::Io(std::io::Error::other(
                    "launch detail\nDetails: C:\\VM\\failure",
                )));
            }
            Ok(Box::new(Session(p)) as Box<dyn LocalSession>)
        })
    }
}
impl LocalSession for Session {
    fn execute(&mut self, _: EngineRequest) -> TransportFuture<'_> {
        let p = self.0.clone();
        Box::pin(async move {
            // Mac-shaped nested blocking work: it survives a dropped outer caller.
            tokio::task::spawn_blocking(move || {
                p.order.lock().unwrap().push("read");
                p.entered.notify_one();
                let (lock, wake) = &p.io;
                let ready = wake
                    .wait_timeout_while(
                        lock.lock().unwrap(),
                        std::time::Duration::from_secs(3),
                        |ready| !*ready,
                    )
                    .unwrap();
                assert!(*ready.0, "test must explicitly finish underlying I/O");
                p.order.lock().unwrap().push("read-done");
                Ok(EngineOutput {
                    exit: 0,
                    stdout: b"kmx v0.9.0\n".to_vec(),
                    stderr: Vec::new(),
                })
            })
            .await
            .unwrap()
        })
    }
    fn stop(&mut self) -> Result<(), RuntimeError> {
        self.0.stops.fetch_add(1, Ordering::SeqCst);
        self.0.order.lock().unwrap().push("stop");
        if self.0.fail_stop {
            Err(RuntimeError::Io(std::io::Error::other("stop detail")))
        } else {
            Ok(())
        }
    }
}
fn owner(p: Arc<Probe>) -> Arc<LocalVm> {
    LocalVm::new(Arc::new(Factory(p)))
}
async fn phase(vm: &LocalVm, expected: LocalVmStatus) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while vm.status() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn finish(p: &Probe) {
    *p.io.0.lock().unwrap() = true;
    p.io.1.notify_all();
}
fn request() -> EngineRequest {
    EngineRequest {
        action: EngineAction::Version {},
    }
}

#[tokio::test]
async fn cancellation_joins_late_session_before_restart_and_change_clears_choice() {
    use bridge_engine::{local_vm, setup::SetupStore};
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(SetupStore::new(Some(temp.path().to_owned())));
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    local_vm::select_local(store.clone(), &vm).await.unwrap();
    phase(&vm, LocalVmStatus::Installing).await;
    let cancelling = {
        let vm = vm.clone();
        let store = store.clone();
        tokio::spawn(async move { local_vm::cancel_local(store, &vm).await })
    };
    phase(&vm, LocalVmStatus::Closing).await;
    vm.start();
    assert_eq!(p.starts.load(Ordering::SeqCst), 1);
    assert!(!cancelling.is_finished());
    p.launch.notify_one();
    let cancelled = serde_json::to_value(cancelling.await.unwrap().unwrap()).unwrap();
    assert_eq!(cancelled["localVm"], "cancelled");
    assert_eq!(cancelled["selected"], "localVm");
    assert_eq!(p.stops.load(Ordering::SeqCst), 1);
    local_vm::select_local(store.clone(), &vm).await.unwrap();
    phase(&vm, LocalVmStatus::Installing).await;
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    let changed = local_vm::change_local(store.clone(), &vm).await.unwrap();
    assert!(changed.selected.is_none());
    assert!(store.status().unwrap().selected.is_none());
    assert_eq!(p.stops.load(Ordering::SeqCst), 2);
    local_vm::select_local(store, &vm).await.unwrap();
    phase(&vm, LocalVmStatus::Installing).await;
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    vm.shutdown().await.unwrap();
    vm.start();
    assert_eq!(p.starts.load(Ordering::SeqCst), 3);
}
#[tokio::test]
async fn cancelled_failed_stop_quarantines_late_session_and_keeps_selection() {
    use bridge_engine::{local_vm, setup::SetupStore};
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(SetupStore::new(Some(temp.path().to_owned())));
    let p = Arc::new(Probe {
        fail_stop: true,
        ..Probe::default()
    });
    let vm = owner(p.clone());
    local_vm::select_local(store.clone(), &vm).await.unwrap();
    phase(&vm, LocalVmStatus::Installing).await;
    let changing = {
        let vm = vm.clone();
        let store = store.clone();
        tokio::spawn(async move { local_vm::change_local(store, &vm).await })
    };
    phase(&vm, LocalVmStatus::Closing).await;
    p.launch.notify_one();
    assert!(changing.await.unwrap().is_err());
    assert_eq!(vm.status(), LocalVmStatus::Failed);
    assert!(store.status().unwrap().selected.is_some());
    vm.start();
    assert_eq!(p.starts.load(Ordering::SeqCst), 1);
    assert!(vm.execute(request()).await.is_err());
}
struct CooperativeFactory;
impl LocalFactory for CooperativeFactory {
    fn launch(
        &self,
        mut cancelled: watch::Receiver<bool>,
        _: Arc<dyn Fn(bridge_engine::local_vm::LocalProgress) + Send + Sync>,
    ) -> StartFuture<'_> {
        Box::pin(async move {
            while !*cancelled.borrow_and_update() {
                cancelled.changed().await.unwrap();
            }
            Err(RuntimeError::Closed)
        })
    }
}
#[tokio::test]
async fn cooperative_cancellation_is_clean_but_terminal_close_is_irreversible() {
    let vm = LocalVm::new(Arc::new(CooperativeFactory));
    vm.start();
    vm.cancel().await.unwrap();
    assert_eq!(vm.status(), LocalVmStatus::Cancelled);
    vm.start();
    assert_eq!(vm.status(), LocalVmStatus::Preparing);
    let cancelling = {
        let vm = vm.clone();
        tokio::spawn(async move { vm.cancel().await })
    };
    vm.request_close();
    cancelling.await.unwrap().unwrap();
    vm.shutdown().await.unwrap();
    assert_eq!(vm.status(), LocalVmStatus::Closed);
    vm.start();
    assert_eq!(vm.status(), LocalVmStatus::Closed);
}
#[tokio::test]
async fn retained_progress_is_optional_and_cleared_after_dropped_change_waiter() {
    use bridge_engine::{local_vm, setup::SetupStore};
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(SetupStore::new(Some(temp.path().to_owned())));
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    let idle =
        serde_json::to_value(local_vm::setup_status(store.clone(), &vm).await.unwrap()).unwrap();
    assert!(idle.get("workspaceProgress").is_none());
    local_vm::select_local(store.clone(), &vm).await.unwrap();
    phase(&vm, LocalVmStatus::Installing).await;
    let installing =
        serde_json::to_value(local_vm::setup_status(store.clone(), &vm).await.unwrap()).unwrap();
    let progress = &installing["workspaceProgress"];
    assert_eq!(progress["phase"], "materializing");
    assert_eq!(progress["bytes"], 800);
    assert_eq!(progress["totalBytes"], 1000);
    assert!(progress["remainingMs"].is_null());
    assert!(progress["elapsedMs"].as_u64().is_some());
    let changing = {
        let vm = vm.clone();
        let store = store.clone();
        tokio::spawn(async move { local_vm::change_local(store, &vm).await })
    };
    phase(&vm, LocalVmStatus::Closing).await;
    changing.abort();
    let _ = changing.await;
    p.launch.notify_one();
    // Joining cancellation proves native stop, but the confirmed preference job also survives.
    vm.cancel().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while store
            .clone()
            .status_async()
            .await
            .unwrap()
            .selected
            .is_some()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let changed = serde_json::to_value(local_vm::setup_status(store, &vm).await.unwrap()).unwrap();
    assert_eq!(changed["localVm"], "cancelled");
    assert!(changed.get("workspaceProgress").is_none());
    assert_eq!(p.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn selection_schedules_only_one_session_and_status_is_observational() {
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    assert_eq!(vm.status(), LocalVmStatus::Idle);
    assert_eq!(p.starts.load(Ordering::SeqCst), 0);
    vm.start();
    vm.start();
    phase(&vm, LocalVmStatus::Installing).await;
    assert_eq!(p.starts.load(Ordering::SeqCst), 1);
    let engine = EngineState::with_transport(vm.clone());
    assert!(
        engine.call(request()).await.is_err(),
        "selection is not readiness"
    );
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    finish(&p);
    assert!(matches!(
        engine.call(request()).await.unwrap(),
        EngineReply::Version { .. }
    ));
    vm.shutdown().await.unwrap();
    assert_eq!(&*p.order.lock().unwrap(), &["read", "read-done", "stop"]);
    assert_eq!(p.stops.load(Ordering::SeqCst), 1);
    vm.start();
    assert_eq!(p.starts.load(Ordering::SeqCst), 1);
    assert!(engine.call(request()).await.is_err());
}
#[tokio::test]
async fn close_during_start_waits_and_stops_late_session_without_ready() {
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    vm.start();
    phase(&vm, LocalVmStatus::Installing).await;
    let closing = {
        let vm = vm.clone();
        tokio::spawn(async move { vm.shutdown().await })
    };
    phase(&vm, LocalVmStatus::Closing).await;
    assert!(!closing.is_finished());
    p.launch.notify_one();
    closing.await.unwrap().unwrap();
    assert_eq!(vm.status(), LocalVmStatus::Closed);
    assert_eq!(p.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn cancelled_request_keeps_session_until_inner_io_finishes_and_refuses_queueing() {
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    vm.start();
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    let engine = Arc::new(EngineState::with_transport(vm.clone()));
    let running = {
        let e = engine.clone();
        tokio::spawn(async move { e.call(request()).await })
    };
    p.entered.notified().await;
    assert_eq!(
        engine.call(request()).await.unwrap_err().kind,
        ErrorKind::Execution
    );
    running.abort();
    let _ = running.await;
    let closing = {
        let vm = vm.clone();
        tokio::spawn(async move { vm.shutdown().await })
    };
    phase(&vm, LocalVmStatus::Closing).await;
    assert!(!closing.is_finished());
    assert_eq!(p.stops.load(Ordering::SeqCst), 0);
    finish(&p);
    closing.await.unwrap().unwrap();
    assert_eq!(&*p.order.lock().unwrap(), &["read", "read-done", "stop"]);
}
#[tokio::test]
async fn cancelled_close_waiter_does_not_abandon_startup_or_custody() {
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    vm.start();
    phase(&vm, LocalVmStatus::Installing).await;
    let closing = {
        let vm = vm.clone();
        tokio::spawn(async move { vm.shutdown().await })
    };
    phase(&vm, LocalVmStatus::Closing).await;
    closing.abort();
    let _ = closing.await;
    p.launch.notify_one();
    vm.shutdown().await.unwrap();
    assert_eq!(vm.status(), LocalVmStatus::Closed);
    assert_eq!(p.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn failed_stop_cannot_claim_closed_clean_or_restart() {
    let p = Arc::new(Probe {
        fail_stop: true,
        ..Probe::default()
    });
    let vm = owner(p.clone());
    vm.start();
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    assert!(vm.shutdown().await.is_err());
    assert_eq!(vm.status(), LocalVmStatus::Failed);
    vm.start();
    assert_eq!(p.starts.load(Ordering::SeqCst), 1);
    assert!(vm.shutdown().await.is_err());
    assert_eq!(p.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn setup_retains_the_actual_stop_error_after_repeated_close() {
    use bridge_engine::{local_vm, setup::SetupStore};
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(SetupStore::new(Some(temp.path().to_owned())));
    let p = Arc::new(Probe {
        fail_stop: true,
        ..Probe::default()
    });
    let vm = owner(p.clone());
    local_vm::select_local(store.clone(), &vm).await.unwrap();
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    assert!(vm.shutdown().await.is_err());
    let failed =
        serde_json::to_value(local_vm::setup_status(store.clone(), &vm).await.unwrap()).unwrap();
    let reason = failed["localVmError"]
        .as_str()
        .expect("stop reason retained");
    assert!(reason.contains("Stopping"), "{reason}");
    assert!(reason.contains("stop detail"), "{reason}");
    assert_eq!(failed["localVm"], "failed");
    assert_eq!(failed["model"], "locked");
    assert_eq!(failed["selected"], "localVm");
    assert!(vm.shutdown().await.is_err());
    let again = serde_json::to_value(local_vm::setup_status(store, &vm).await.unwrap()).unwrap();
    assert_eq!(again, failed);
    assert_eq!(p.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn setup_retains_the_actual_start_error_including_during_close() {
    use bridge_engine::{local_vm, setup::SetupStore};
    for during_close in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(SetupStore::new(Some(temp.path().to_owned())));
        let p = Arc::new(Probe {
            fail_launch: true,
            ..Probe::default()
        });
        let vm = owner(p.clone());
        local_vm::select_local(store.clone(), &vm).await.unwrap();
        phase(&vm, LocalVmStatus::Installing).await;
        if during_close {
            vm.request_close();
        }
        p.launch.notify_one();
        if !during_close {
            phase(&vm, LocalVmStatus::Failed).await;
            let failed =
                serde_json::to_value(local_vm::setup_status(store.clone(), &vm).await.unwrap())
                    .unwrap();
            let reason = failed["localVmError"]
                .as_str()
                .expect("start reason retained");
            assert!(reason.contains("Starting"), "{reason}");
            assert!(
                reason.contains("launch detail\nDetails: C:\\VM\\failure"),
                "{reason}"
            );
        }
        assert!(vm.shutdown().await.is_err());
        let failed =
            serde_json::to_value(local_vm::setup_status(store.clone(), &vm).await.unwrap())
                .unwrap();
        let reason = failed["localVmError"]
            .as_str()
            .expect("start reason survives close");
        assert!(reason.contains("Starting"), "{reason}");
        assert!(
            reason.contains("launch detail\nDetails: C:\\VM\\failure"),
            "{reason}"
        );
        assert_eq!(failed["localVm"], "failed");
        assert_eq!(failed["model"], "locked");
        assert!(vm.shutdown().await.is_err());
        let again =
            serde_json::to_value(local_vm::setup_status(store, &vm).await.unwrap()).unwrap();
        assert_eq!(again, failed);
        assert_eq!(p.stops.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn native_unconfigured_owner_never_starts_from_selection() {
    let vm = LocalVm::unavailable();
    vm.start();
    assert_eq!(vm.status(), LocalVmStatus::NotIntegrated);
    vm.shutdown().await.unwrap();
    assert!(vm.execute(request()).await.is_err());
}
#[tokio::test]
async fn startup_error_cannot_become_clean_close_with_an_empty_session_slot() {
    for during_close in [false, true] {
        let p = Arc::new(Probe {
            fail_launch: true,
            ..Probe::default()
        });
        let vm = owner(p.clone());
        vm.start();
        phase(&vm, LocalVmStatus::Installing).await;
        if during_close {
            vm.request_close();
        }
        p.launch.notify_one();
        if !during_close {
            phase(&vm, LocalVmStatus::Failed).await;
        }
        assert!(
            vm.shutdown().await.is_err(),
            "joining a returned task is not proof of successful native cleanup"
        );
        assert_eq!(vm.status(), LocalVmStatus::Failed);
        assert_eq!(p.stops.load(Ordering::SeqCst), 0);
        assert!(vm.shutdown().await.is_err());
    }
}
#[test]
fn native_close_signal_bars_ready_without_an_async_runtime() {
    let vm = LocalVm::unavailable();
    vm.request_close();
    assert_eq!(vm.status(), LocalVmStatus::Closing);
}
#[tokio::test]
async fn setup_selection_persists_then_starts_but_status_never_starts() {
    use bridge_engine::{local_vm, setup::SetupStore};
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(SetupStore::new(Some(temp.path().to_owned())));
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    let observed = local_vm::setup_status(store.clone(), &vm).await.unwrap();
    assert!(observed.selected.is_none());
    assert_eq!(p.starts.load(Ordering::SeqCst), 0);
    let selected = local_vm::select_local(store.clone(), &vm).await.unwrap();
    assert!(selected.selected.is_some());
    assert!(temp.path().join("setup-v1/local-vm").is_file());
    phase(&vm, LocalVmStatus::Installing).await;
    assert_eq!(p.starts.load(Ordering::SeqCst), 1);
    local_vm::select_local(store.clone(), &vm).await.unwrap();
    assert_eq!(p.starts.load(Ordering::SeqCst), 1);
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    let value = serde_json::to_value(local_vm::setup_status(store, &vm).await.unwrap()).unwrap();
    assert_eq!(value["localVm"], "ready");
    assert!(value.get("localVmError").unwrap().is_null());
    assert_eq!(
        value["model"],
        if cfg!(target_os = "macos") {
            "locked"
        } else {
            "available"
        }
    );
    assert!(
        !temp.path().join("setup-v1/model-v1").exists(),
        "status must not capture or associate a sign-in"
    );
    vm.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_resume_starts_only_a_saved_choice_without_resaving_it() {
    use bridge_engine::{local_vm, setup::SetupStore};
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(SetupStore::new(Some(temp.path().to_owned())));
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    local_vm::resume_selected(store.clone(), &vm).await.unwrap();
    assert_eq!(p.starts.load(Ordering::SeqCst), 0);
    store.select_local().unwrap();
    local_vm::resume_selected(store, &vm).await.unwrap();
    phase(&vm, LocalVmStatus::Installing).await;
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    vm.shutdown().await.unwrap();
}
#[test]
fn fixed_example_is_the_exact_public_pair_not_an_edit_or_run_operation() {
    use sha2::{Digest, Sha256};
    let pair = bridge_engine::local_vm::example();
    assert_eq!(
        format!("{:x}", Sha256::digest(pair.agent.as_bytes())),
        "5c92e1867edf076e62723120a12264a0c5106e3047bfc8901973803f440c39af"
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(pair.tests.as_bytes())),
        "710f4309a3b482ccc41049b204a9d464460ed4285285d73f5e58e7487c62c3ba"
    );
    assert!(pair.agent.len() < 65536 && pair.tests.len() < 65536);
}
#[tokio::test]
async fn engine_shutdown_bars_transport_calls() {
    let p = Arc::new(Probe::default());
    let vm = owner(p.clone());
    vm.start();
    p.launch.notify_one();
    phase(&vm, LocalVmStatus::Ready).await;
    finish(&p);
    let engine = EngineState::with_transport(vm.clone());
    engine.shutdown();
    assert!(engine.call(request()).await.is_err());
    assert!(p.order.lock().unwrap().is_empty());
    vm.shutdown().await.unwrap();
}
