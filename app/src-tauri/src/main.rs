#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bridge_engine::agent_folder::{AgentFolder, AgentPair};
use bridge_engine::engine::{types::*, EngineState};
use bridge_engine::local_vm::{self, ExamplePair, LocalVm, LocalVmStatus};
use bridge_engine::setup::{SetupError, SetupSnapshot, SetupStore};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

#[tauri::command]
async fn engine_call(
    request: EngineRequest,
    state: tauri::State<'_, EngineState>,
) -> Result<EngineReply, EngineError> {
    state.call(request).await
}
#[tauri::command]
async fn setup_status(
    state: tauri::State<'_, Arc<SetupStore>>,
    vm: tauri::State<'_, Arc<LocalVm>>,
) -> Result<SetupSnapshot, SetupError> {
    local_vm::setup_status(Arc::clone(state.inner()), vm.inner()).await
}
#[tauri::command]
async fn setup_select_local(
    state: tauri::State<'_, Arc<SetupStore>>,
    vm: tauri::State<'_, Arc<LocalVm>>,
) -> Result<SetupSnapshot, SetupError> {
    local_vm::select_local(Arc::clone(state.inner()), vm.inner()).await
}
#[tauri::command]
async fn setup_cancel_local(
    state: tauri::State<'_, Arc<SetupStore>>,
    vm: tauri::State<'_, Arc<LocalVm>>,
) -> Result<SetupSnapshot, SetupError> {
    local_vm::cancel_local(Arc::clone(state.inner()), vm.inner()).await
}
#[tauri::command]
async fn setup_change_local(
    state: tauri::State<'_, Arc<SetupStore>>,
    vm: tauri::State<'_, Arc<LocalVm>>,
) -> Result<SetupSnapshot, SetupError> {
    local_vm::change_local(Arc::clone(state.inner()), vm.inner()).await
}
#[tauri::command]
fn setup_requirements() -> Option<bridge_engine::setup::SetupRequirements> {
    bridge_engine::setup::setup_requirements()
}
#[tauri::command]
async fn setup_open_help(topic: bridge_engine::setup::help::HelpTopic) -> Result<(), &'static str> {
    tauri::async_runtime::spawn_blocking(move || bridge_engine::setup::help::open_help(topic))
        .await
        .map_err(|_| "Could not open setup help.")?
}
#[tauri::command]
fn setup_example() -> ExamplePair {
    local_vm::example()
}

#[tauri::command]
async fn agent_open(state: tauri::State<'_, Arc<AgentFolder>>) -> Result<AgentPair, &'static str> {
    let folder = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || folder.open())
        .await
        .map_err(|_| "The local agent folder is unavailable.")?
}
#[tauri::command]
async fn agent_save(
    content: String,
    state: tauri::State<'_, Arc<AgentFolder>>,
) -> Result<AgentPair, &'static str> {
    let folder = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || folder.save(content))
        .await
        .map_err(|_| "The local agent folder is unavailable.")?
}

#[derive(serde::Serialize)]
struct ModelReply {
    ready: bool,
}
#[tauri::command]
async fn setup_connect_model(
    state: tauri::State<'_, Arc<SetupStore>>,
    vm: tauri::State<'_, Arc<LocalVm>>,
) -> Result<ModelReply, SetupError> {
    let model = vm.connect_model(Arc::clone(state.inner())).await?;
    Ok(ModelReply { ready: model.ready })
}

#[tauri::command]
fn setup_run_status(
    state: tauri::State<'_, Arc<bridge_engine::example_run::ExampleRun>>,
    vm: tauri::State<'_, Arc<LocalVm>>,
) -> bridge_engine::example_run::RunSnapshot {
    state.status(vm.inner())
}
#[tauri::command]
fn setup_run_example(
    state: tauri::State<'_, Arc<bridge_engine::example_run::ExampleRun>>,
    vm: tauri::State<'_, Arc<LocalVm>>,
) -> bridge_engine::example_run::RunSnapshot {
    state.inner().start(vm.inner().clone())
}

fn main() {
    let closing = AtomicBool::new(false);
    let completed = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .setup(|app| {
            let store = Arc::new(SetupStore::new(app.path().app_data_dir().ok()));
            let vm = local_vm::configured(app.path().resource_dir().ok(), app.path().app_local_data_dir().ok());
            app.manage(if vm.status() == LocalVmStatus::NotIntegrated { EngineState::configured() }
                else { EngineState::with_transport(vm.clone()) });
            app.manage(store.clone()); app.manage(vm.clone());
            let folder = Arc::new(AgentFolder::new(app.path().home_dir().ok()));
            app.manage(folder.clone());
            app.manage(bridge_engine::example_run::ExampleRun::new(tauri::async_runtime::handle().inner().clone(), bridge_engine::local_vm::MODEL_IMAGE_AVAILABLE, folder));
            tauri::async_runtime::spawn(async move {
                if local_vm::resume_selected(store, &vm).await.is_err() {
                    eprintln!("The saved setup choice could not be read.");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_call, setup_status, setup_select_local, setup_cancel_local, setup_change_local, setup_requirements, setup_open_help, setup_example, setup_connect_model, setup_run_status, setup_run_example, agent_open, agent_save])
        .build(tauri::generate_context!())
        .expect("error while building Bridge")
        .run(move |app, event| {
            if completed.load(Ordering::SeqCst) { return; }
            let requested = match event {
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => { api.prevent_close(); true }
                tauri::RunEvent::ExitRequested { api, .. } => { api.prevent_exit(); true }
                _ => false,
            };
            if !requested || closing.swap(true, Ordering::SeqCst) { return; }
            let vm = app.state::<Arc<LocalVm>>().inner().clone();
            vm.request_close(); // Native event thread: bar late Ready before scheduling async work.
            app.state::<EngineState>().shutdown();
            let handle = app.clone(); let completed = completed.clone();
            tauri::async_runtime::spawn(async move {
                let clean = vm.shutdown().await.is_ok();
                if !clean { eprintln!("Local VM startup or shutdown did not finish successfully; cleanup was not reported as clean."); }
                completed.store(true, Ordering::SeqCst);
                handle.exit(if clean { 0 } else { 1 });
            });
        });
}
