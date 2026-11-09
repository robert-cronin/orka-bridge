//! Fixed example Run on the original VM client. Credentials remain in the guest.
use crate::{
    agent_folder::AgentFolder,
    engine::run::{
        ErrorKind, NativeRunner, ParsedPair, RunFuture, RunHandle, RunLimits, RunReport,
        RunTransport,
    },
    local_vm::{LocalVm, LocalVmStatus},
    pair_source::CapturedPair,
    runtime::client::VmClient,
};
use bridge_runtime_protocol::{ModelPhase, OrkaRequest, SnapshotId, MAX_ORKA_BODY};
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::{sync::watch, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    Idle,
    Running,
    Complete,
    Unknown,
}
#[derive(Clone, Serialize)]
pub struct Receipt {
    pub kind: &'static str,
    pub name: String,
    pub uid: String,
}
#[derive(Clone, Serialize)]
pub struct PendingRef {
    pub kind: &'static str,
    pub name: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub state: RunState,
    pub can_run: bool,
    pub model_connected: bool,
    pub source: Option<SnapshotId>,
    pub report: Option<RunReport>,
    pub acknowledged: Vec<Receipt>,
    pub pending: Option<PendingRef>,
    pub error: Option<&'static str>,
}
struct State {
    snapshot: RunSnapshot,
    handle: Option<RunHandle>,
}
pub struct ExampleRun(Mutex<State>, tokio::runtime::Handle, bool, Arc<AgentFolder>);
impl ExampleRun {
    /// The native shell supplies its runtime; a blocking IPC thread need not enter it.
    pub fn new(
        runtime: tokio::runtime::Handle,
        model_image_available: bool,
        folder: Arc<AgentFolder>,
    ) -> Arc<Self> {
        Arc::new(Self(
            Mutex::new(State {
                snapshot: RunSnapshot {
                    state: RunState::Idle,
                    can_run: false,
                    model_connected: false,
                    source: None,
                    report: None,
                    acknowledged: Vec::new(),
                    pending: None,
                    error: None,
                },
                handle: None,
            }),
            runtime,
            model_image_available,
            folder,
        ))
    }
    /// Observation only, including after a renderer remount; never submits or loads credentials.
    pub fn status(&self, vm: &LocalVm) -> RunSnapshot {
        let mut snapshot = self.0.lock().unwrap().snapshot.clone();
        snapshot.model_connected = vm.model_connected();
        snapshot.can_run =
            self.2 && snapshot.state != RunState::Running && vm.status() == LocalVmStatus::Ready;
        snapshot
    }
    pub fn start(self: &Arc<Self>, vm: Arc<LocalVm>) -> RunSnapshot {
        if !self.2 {
            return self.status(&vm);
        }
        {
            let mut state = self.0.lock().unwrap();
            if state.snapshot.state == RunState::Running {
                drop(state);
                return self.status(&vm);
            }
            state.snapshot.state = RunState::Running;
            state.snapshot.can_run = false;
            state.snapshot.error = None;
            state.snapshot.report = None;
            state.snapshot.source = None;
            // Keep remote identities through session/model preflight failures.
            // record() replaces them when submission returns a new handle.
        }
        let owner = self.clone();
        let target = vm.clone();
        // The owned task and worker publish receipts without depending on an IPC waiter.
        self.1.spawn(async move {
            let source = owner.3.clone();
            // Freeze once per admission, before waiting for the serialized VM client.
            let pair = tokio::task::spawn_blocking(move || {
                let snapshot = source.capture().map_err(|_| ())?;
                CapturedPair::from_snapshot(snapshot).map_err(|_| ())
            })
            .await;
            let Ok(Ok(pair)) = pair else {
                owner.fail("source");
                return;
            };
            let pair = pair.into_pair();
            owner.0.lock().unwrap().snapshot.source = Some(pair.snapshot().clone());
            let runtime = tokio::runtime::Handle::current();
            let worker = owner.clone();
            let observing = target.clone();
            let result = target
                .with_client(move |_, client| {
                    runtime.block_on(worker.execute(client, observing, pair))
                })
                .await;
            if result.is_err() {
                owner.fail("session");
            }
        });
        self.status(&vm)
    }
    fn fail(&self, message: &'static str) {
        let mut state = self.0.lock().unwrap();
        state.snapshot.state = RunState::Unknown;
        state.snapshot.error = Some(message);
    }
    async fn execute(&self, client: &mut VmClient, vm: Arc<LocalVm>, pair: ParsedPair) {
        let model = match client.model_status() {
            Ok(model) if model.phase == ModelPhase::Ready => model,
            Ok(_) => {
                vm.clear_model_acknowledgment();
                self.fail("model");
                return;
            }
            Err(_) => {
                self.fail("session");
                return;
            }
        };
        let Some(connection) = model.connection else {
            self.fail("model");
            return;
        };
        let runner = NativeRunner::with_transport(VmRunTransport {
            client: Mutex::new(client),
            provider: connection.selection.provider,
            vm,
        });
        let prepared = match runner.prepare(pair) {
            Ok(prepared) => prepared,
            Err(_) => {
                // A refusal before writes must not discard an earlier attempt's receipts.
                self.fail("submit");
                return;
            }
        };
        let (_sender, stop) = watch::channel(false);
        let handle = match runner.submit_prepared(prepared, stop).await {
            Ok(handle) => handle,
            Err(error) => {
                self.record(
                    &error.handle,
                    error.pending.map(|p| PendingRef {
                        kind: p.kind,
                        name: p.name,
                    }),
                    None,
                );
                self.fail("submit");
                return;
            }
        };
        self.record(&handle, None, None);
        match runner.observe(&handle).await {
            Ok(report) => {
                self.record(&handle, None, Some(report));
                self.0.lock().unwrap().snapshot.state = RunState::Complete;
            }
            Err(_) => self.fail("observe"),
        }
    }
    fn record(&self, handle: &RunHandle, pending: Option<PendingRef>, report: Option<RunReport>) {
        let mut state = self.0.lock().unwrap();
        state.handle = Some(handle.clone());
        state.snapshot.acknowledged = handle
            .agent()
            .map(|r| Receipt {
                kind: "Agent",
                name: r.name.clone(),
                uid: r.uid.clone(),
            })
            .into_iter()
            .chain(handle.tasks().iter().map(|r| Receipt {
                kind: "Task",
                name: r.name.clone(),
                uid: r.uid.clone(),
            }))
            .collect();
        state.snapshot.pending = pending;
        state.snapshot.report = report;
    }
}
struct VmRunTransport<'a> {
    client: Mutex<&'a mut VmClient>,
    provider: String,
    vm: Arc<LocalVm>,
}
impl RunTransport for VmRunTransport<'_> {
    fn namespace(&self) -> &str {
        "orka-system"
    }
    fn provider(&self) -> &str {
        &self.provider
    }
    fn limits(&self) -> RunLimits {
        RunLimits::default()
    }
    fn max_create_body_bytes(&self) -> Option<usize> {
        Some(MAX_ORKA_BODY)
    }
    fn request<'a>(
        &'a self,
        path: &'a str,
        after: Option<u64>,
        body: Option<&'a Value>,
        deadline: Instant,
    ) -> RunFuture<'a> {
        Box::pin(async move {
            if self.vm.status() != LocalVmStatus::Ready {
                return Err(ErrorKind::Transport);
            }
            if Instant::now() >= deadline {
                return Err(ErrorKind::Deadline);
            }
            let reply = self
                .client
                .lock()
                .map_err(|_| ErrorKind::Transport)?
                .orka_request(OrkaRequest {
                    path: path.into(),
                    after,
                    body: body.cloned(),
                })
                .map_err(|_| ErrorKind::Transport)?;
            if reply.status != if body.is_some() { 201 } else { 200 } {
                return Err(ErrorKind::Response);
            }
            Ok(reply.body)
        })
    }
}
