// Exercise the native storage owner on Linux as well as native desktop CI.
extern crate self as bridge_engine;
#[path = "../../../app/src-tauri/src/agent_folder.rs"]
pub mod agent_folder;
#[path = "../../../app/src-tauri/src/runtime/snapshot.rs"]
pub mod snapshot;
pub mod runtime {
    pub use crate::snapshot;
}
include!("../../../app/src-tauri/tests/agent_folder.rs");
