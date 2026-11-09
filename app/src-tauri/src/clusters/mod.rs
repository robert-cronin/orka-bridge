mod client;
mod forward;
use bridge_runtime_protocol::Uuid;
pub use client::{ClusterClient, RemoteAccess};
pub use forward::{OrkaStreamTransport, PodOrkaRead};
use serde::Serialize;
use serde_json::Value;
use std::{future::Future, pin::Pin};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
pub struct ContextId(pub(crate) Uuid);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
pub struct TargetId(pub(crate) Uuid);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
pub struct ProviderId(pub(crate) Uuid);
#[derive(Clone, Debug, Serialize)]
pub struct ContextView {
    pub id: ContextId,
    pub name: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct TargetView {
    pub id: TargetId,
    pub context_id: ContextId,
    pub context_name: String,
    pub service_name: String,
    pub service_namespace: String,
    pub watched_namespace: String,
    pub image: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct ProviderView {
    pub id: ProviderId,
    pub name: String,
    pub ready: bool,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetBinding {
    pub context_id: ContextId,
    pub context_name: String,
    pub server_address: String,
    pub service_name: String,
    pub service_namespace: String,
    pub service_uid: String,
    pub deployment_name: String,
    pub deployment_namespace: String,
    pub deployment_uid: String,
    pub watched_namespace: String,
    pub image: String,
    pub api_port: u16,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForwardPeer {
    pub pod_name: String,
    pub pod_namespace: String,
    pub pod_uid: String,
    pub port: u16,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClusterError {
    Unavailable,
    Denied,
    UnsupportedCredential,
    MissingTool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessOutcome {
    NeedServiceAccount,
    Denied,
    Unavailable,
    UnsupportedCredential,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrkaResource {
    WhoAmI,
    Agents,
    Providers,
    Tools,
}
/// Native GET-only seam. The implementation owns the selected pod stream, not an arbitrary URL.
pub trait OrkaRead: Send + Sync {
    fn get<'a>(
        &'a self,
        creator: &'a kube::Client,
        binding: &'a TargetBinding,
        bearer: &'a str,
        resource: OrkaResource,
        namespace: &'a str,
        after: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AccessOutcome>> + Send + 'a>>;
}
