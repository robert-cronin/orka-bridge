use crate::{CredentialState, Uuid};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
}
impl ModelSelection {
    pub fn valid(&self) -> bool {
        let p = self.provider.as_bytes();
        !p.is_empty()
            && p.len() <= 45
            && p.first().is_some_and(u8::is_ascii_alphanumeric)
            && p.last().is_some_and(u8::is_ascii_alphanumeric)
            && p.iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
            && !self.model.is_empty()
            && self.model.len() <= 256
            && self.model.bytes().all(|b| (b'!'..=b'~').contains(&b))
            && !self.model.eq_ignore_ascii_case("auto")
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelPhase {
    Idle,
    Ready,
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConnection {
    pub id: Uuid,
    pub selection: ModelSelection,
    pub generation: Uuid,
}
// Only closed diagnostic vocabulary crosses the guest boundary; raw kmx output never does.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelDiagnosticClass {
    Process,
    Timeout,
    OutputLimit,
    InvalidReply,
    Exit,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelStage {
    Preflight,
    Gateway,
    Provider,
    Model,
    Finalize,
    Other,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelErrorCode {
    InvalidArguments,
    ConfigurationInvalid,
    Unsupported,
    ConfirmationRequired,
    CredentialUnavailable,
    PermissionDenied,
    DependencyUnavailable,
    ExecutionUnknown,
    Cancelled,
    DeadlineExceeded,
    OutputFailed,
    OperationFailed,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum ModelStderr {
    #[serde(rename = "The command arguments are invalid.")]
    InvalidArguments,
    #[serde(rename = "The configuration is invalid.")]
    ConfigurationInvalid,
    #[serde(rename = "The requested operation is unsupported.")]
    Unsupported,
    #[serde(rename = "Target confirmation is required.")]
    ConfirmationRequired,
    #[serde(rename = "A required credential is unavailable.")]
    CredentialUnavailable,
    #[serde(rename = "The operation was not permitted.")]
    PermissionDenied,
    #[serde(rename = "A required dependency is unavailable.")]
    DependencyUnavailable,
    #[serde(rename = "The execution outcome is unknown.")]
    ExecutionUnknown,
    #[serde(rename = "The operation was cancelled.")]
    Cancelled,
    #[serde(rename = "The operation deadline was exceeded.")]
    DeadlineExceeded,
    #[serde(rename = "Cannot write machine output.")]
    OutputFailed,
    #[serde(rename = "The operation failed.")]
    OperationFailed,
    #[serde(rename = "Stderr withheld.")]
    Withheld,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelDiagnostic {
    pub classification: ModelDiagnosticClass,
    pub elapsed_ms: u64,
    pub exit_code: Option<i32>,
    pub stage: Option<ModelStage>,
    pub error_code: Option<ModelErrorCode>,
    pub stderr: Option<ModelStderr>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelState {
    pub phase: ModelPhase,
    pub connection: Option<ModelConnection>,
    pub credential: CredentialState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<ModelDiagnostic>,
}
impl ModelState {
    pub(crate) fn valid(&self) -> bool {
        self.credential.valid()
            && self.connection.as_ref().is_none_or(|c| {
                !c.id.is_nil()
                    && !c.generation.is_nil()
                    && c.selection.valid()
                    && self.credential.generation == Some(c.generation)
            })
            && match self.phase {
                ModelPhase::Idle => self.connection.is_none(),
                ModelPhase::Ready => self.connection.is_some() && self.credential.installed,
                ModelPhase::Unknown => true,
            }
    }
}
