use super::*;
use crate::setup::{ModelSetupState, SetupError, SetupStore};
use bridge_runtime_protocol::*;

#[tokio::test]
async fn restart_cannot_reuse_the_previous_sessions_model_acknowledgment() {
    struct Factory;
    impl LocalFactory for Factory {
        fn launch(
            &self,
            mut closed: watch::Receiver<bool>,
            _: Arc<dyn Fn(LocalProgress) + Send + Sync>,
        ) -> StartFuture<'_> {
            Box::pin(async move {
                if !*closed.borrow() {
                    let _ = closed.changed().await;
                }
                Err(RuntimeError::Closed)
            })
        }
    }
    let vm = LocalVm::new(Arc::new(Factory));
    vm.inner
        .publish(LocalProgress::Status(LocalVmStatus::Ready));
    vm.inner.model_result(&Ok(ModelSetupState {
        associated: true,
        ready: true,
        unknown: false,
        connection: None,
    }));
    assert!(vm.model_connected());
    vm.inner
        .publish(LocalProgress::Status(LocalVmStatus::Cancelled));
    vm.start();
    // Completing a new workspace boot is not a new model acknowledgment.
    vm.inner
        .publish(LocalProgress::Status(LocalVmStatus::Ready));
    assert!(!vm.model_connected());
    vm.shutdown().await.unwrap();
}

#[test]
fn model_failure_details_survive_generic_retry_without_failing_the_running_vm() {
    let tmp = tempfile::tempdir().unwrap();
    let store = SetupStore::new(Some(tmp.path().to_owned()));
    store.select_local().unwrap();
    let vm = LocalVm::unavailable();
    vm.inner.state.lock().unwrap().phase = LocalVmStatus::Ready;
    assert!(
        !vm.model_connected(),
        "workspace readiness is not a model acknowledgment"
    );
    let failure = Err(SetupError::connect(Some(ModelDiagnostic {
        classification: ModelDiagnosticClass::Timeout,
        elapsed_ms: 60_000,
        exit_code: Some(-1),
        stage: Some(ModelStage::Gateway),
        error_code: None,
        stderr: Some(ModelStderr::Withheld),
    })));
    vm.inner.model_result(&failure);
    let first = serde_json::to_value(vm.snapshot(store.status().unwrap())).unwrap();
    assert_eq!(first["localVm"], "ready");
    assert!(first["localVmError"].as_str().unwrap().contains("gateway"));
    assert!(first["localVmError"].as_str().unwrap().contains("60000"));
    vm.inner
        .model_result(&Err(SetupError::model("modelUnavailable")));
    let retried = serde_json::to_value(vm.snapshot(store.status().unwrap())).unwrap();
    assert_eq!(retried["localVmError"], first["localVmError"]);
    let success = Ok(ModelSetupState {
        associated: true,
        ready: true,
        unknown: false,
        connection: None,
    });
    vm.inner.model_result(&success);
    let ready = serde_json::to_value(vm.snapshot(store.status().unwrap())).unwrap();
    assert!(ready["localVmError"].is_null());
    assert!(vm.model_connected());
    vm.clear_model_acknowledgment();
    assert!(!vm.model_connected());
    vm.inner.model_result(&success);
    assert!(vm.model_connected());
    vm.request_close();
    assert!(!vm.model_connected());
}
