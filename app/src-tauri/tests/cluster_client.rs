#[path = "support/cluster_tls_fixture.rs"]
mod tls_fixture;
use bridge_engine::clusters::*;
use kube::config::Kubeconfig;
use serde_json::{json, Value};
use std::{
    future::Future,
    io::{Read, Write},
    net::TcpListener,
    pin::Pin,
    sync::{Arc, Mutex},
};

#[path = "support/cluster_forward.rs"]
mod forward;

#[derive(Default)]
struct ApiFixture {
    wire: forward::Wire,
    calls: Mutex<Vec<(String, String, String, Value)>>,
    deny: Mutex<bool>,
    replacement: Mutex<bool>,
    no_watch: Mutex<bool>,
    unrelated_api: Mutex<bool>,
    override_response: Mutex<Option<(String, u16, Value)>>,
}
impl ApiFixture {
    fn start(self: &Arc<Self>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let fixture = self.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let fixture = fixture.clone();
                std::thread::spawn(move || {
                    let mut stream = stream.unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut buf = [0; 4096];
                    let header_end = loop {
                        let n = stream.read(&mut buf).unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if let Some(i) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                    let mut first = headers.lines().next().unwrap().split_whitespace();
                    let method = first.next().unwrap().to_string();
                    let path = first.next().unwrap().to_string();
                    let header = |name: &str| {
                        headers.lines().find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case(name)
                                .then(|| value.trim().to_string())
                        })
                    };
                    if path.contains("/portforward") {
                        fixture.wire.serve(stream, &headers);
                        return;
                    }
                    let len = header("content-length")
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    while bytes.len() < header_end + len {
                        let n = stream.read(&mut buf).unwrap();
                        bytes.extend_from_slice(&buf[..n]);
                    }
                    let body = serde_json::from_slice(&bytes[header_end..]).unwrap_or(Value::Null);
                    fixture.calls.lock().unwrap().push((
                        method,
                        path.split('?').next().unwrap().into(),
                        header("authorization").unwrap_or_default(),
                        body,
                    ));
                    let (status, response) = fixture.response(path.split('?').next().unwrap());
                    let body = response.to_string();
                    write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                });
            }
        });
        address
    }
    fn response(&self, path: &str) -> (u16, Value) {
        if let Some((suffix, status, body)) = self.override_response.lock().unwrap().as_ref() {
            if path.ends_with(suffix) {
                return (*status, body.clone());
            }
        }
        if path.ends_with("/token") {
            return (
                200,
                json!({"apiVersion":"authentication.k8s.io/v1","kind":"TokenRequest", "spec":{"audiences":[]}, "status":{"token":"issued-fixture","expirationTimestamp":"2099-01-01T00:00:00Z"}}),
            );
        }
        if path.ends_with("/selfsubjectaccessreviews") {
            return (
                200,
                json!({"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{},"status":{"allowed": !*self.deny.lock().unwrap()}}),
            );
        }
        if path.contains("/customresourcedefinitions/") {
            let name = path.rsplit('/').next().unwrap();
            let plural = name.split('.').next().unwrap();
            return (
                200,
                json!({"apiVersion":"apiextensions.k8s.io/v1","kind":"CustomResourceDefinition","metadata":{"name":name},"spec":{"group":"core.orka.ai","scope":"Namespaced","names":{"kind":"Fixture","plural":plural},"versions":[{"name":"v1alpha1","served":true,"storage":true}]}}),
            );
        }
        if path.ends_with("/pods") {
            return (
                200,
                json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[
                    {"metadata":{"name":"not-ready","namespace":"control","uid":"bad","labels":{"app":"orka"}},"spec":{"containers":[]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"False"}]}},
                    {"metadata":{"name":"ready","namespace":"control","uid":"pod-uid","labels":{"app":"orka"}},"spec":{"containers":[{"name":"controller","ports":[{"name":"api","containerPort":8080}]}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}
                ]}),
            );
        }
        if path.ends_with("/services") {
            let uid = if *self.replacement.lock().unwrap() {
                "replacement"
            } else {
                "service-uid"
            };
            let mut list = json!({"apiVersion":"v1","kind":"ServiceList","metadata":{},"items":[{"metadata":{"name":"orka","namespace":"control","uid":uid},"spec":{"selector":{"app":"orka"},"ports":[{"name":"api","port":80,"targetPort":"api"}]}}]});
            if *self.unrelated_api.lock().unwrap() {
                list["items"].as_array_mut().unwrap().push(json!({"metadata":{"name":"other","namespace":"control","uid":"other-service"},"spec":{"selector":{"app":"other"},"ports":[{"name":"api","port":80,"targetPort":9000}]}}));
            }
            return (200, list);
        }
        if path.ends_with("/deployments") {
            let args = if *self.no_watch.lock().unwrap() {
                json!(["--api-port=8080"])
            } else {
                json!(["--api-port=8080", "--watch-namespace=agents"])
            };
            let mut list = json!({"apiVersion":"apps/v1","kind":"DeploymentList","metadata":{},"items":[{"metadata":{"name":"controller","namespace":"control","uid":"deployment-uid"},"spec":{"selector":{"matchLabels":{"app":"orka"}},"template":{"metadata":{"labels":{"app":"orka"}},"spec":{"containers":[{"name":"controller","image":"ghcr.io/orka-agents/orka:v99","args":args,"ports":[{"name":"api","containerPort":8080}]}]}}}}]});
            if *self.unrelated_api.lock().unwrap() {
                list["items"][0]["spec"]["template"]["metadata"]["labels"]
                    ["app.kubernetes.io/name"] = json!("orka");
                list["items"][0]["spec"]["template"]["spec"]["containers"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"name":"sidecar","image":"example/sidecar:v1"}));
                list["items"].as_array_mut().unwrap().push(json!({"metadata":{"name":"other","namespace":"control","uid":"other-deployment"},"spec":{"selector":{"matchLabels":{"app":"other"}},"template":{"metadata":{"labels":{"app":"other"}},"spec":{"containers":[{"name":"server","image":"example/api:v1","args":["--api-port=9000","--watch-namespace=agents"]}]}}}}));
            }
            return (200, list);
        }
        panic!("unexpected Kubernetes path {path}");
    }
}

type OrkaCall = (OrkaResource, String, String, Option<String>);
struct OrkaFixture {
    calls: Mutex<Vec<OrkaCall>>,
    providers: Mutex<Option<Value>>,
    identity: Mutex<Value>,
    fail: Mutex<Option<AccessOutcome>>,
    echo: Mutex<bool>,
    paged: Mutex<bool>,
}
impl Default for OrkaFixture {
    fn default() -> Self {
        Self {
            calls: Mutex::default(),
            providers: Mutex::new(None),
            identity: Mutex::new(
                json!({"authenticated":true,"authType":"tokenReview","namespace":"agents"}),
            ),
            fail: Mutex::new(None),
            echo: Mutex::new(false),
            paged: Mutex::new(false),
        }
    }
}
impl OrkaRead for OrkaFixture {
    fn get<'a>(
        &'a self,
        _: &'a kube::Client,
        _: &'a TargetBinding,
        bearer: &'a str,
        resource: OrkaResource,
        namespace: &'a str,
        after: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AccessOutcome>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((
                resource,
                bearer.into(),
                namespace.into(),
                after.map(str::to_string),
            ));
            if let Some(error) = *self.fail.lock().unwrap() {
                return Err(error);
            }
            if *self.echo.lock().unwrap() {
                return Ok(json!({"echo":bearer}));
            }
            Ok(match resource {
                OrkaResource::WhoAmI if bearer == "issued-fixture" => json!({"authenticated":true,"authType":"tokenReview","namespace":"agents"}),
                OrkaResource::WhoAmI => self.identity.lock().unwrap().clone(),
                OrkaResource::Providers => self.providers.lock().unwrap().clone().unwrap_or_else(|| {
                    json!({"items":[{"apiVersion":"core.orka.ai/v1alpha1","kind":"Provider","metadata":{"name":"model","namespace":"agents"},"spec":{"type":"openai","defaultModel":"fixture-model"},"status":{"ready":true}}],"metadata":{}})
                }),
                OrkaResource::Tools if *self.paged.lock().unwrap() && after.is_none() => {
                    json!({"items":[{"name":"custom","builtin":false}],"metadata":{"continue":"next"}})
                }
                OrkaResource::Tools => {
                    json!({"items":[{"name":"web_fetch","builtin":true}],"metadata":{}})
                }
                OrkaResource::Agents => json!({"items":[],"metadata":{}}),
            })
        })
    }
}
fn config(server: &str, auth: Value) -> Kubeconfig {
    serde_json::from_value(json!({"apiVersion":"v1","kind":"Config","current-context":"wrong","clusters":[{"name":"fixture","cluster":{"server":server}}],"users":[{"name":"user","user":auth}],"contexts":[{"name":"selected","context":{"cluster":"fixture","user":"user"}},{"name":"exec","context":{"cluster":"fixture","user":"helper"}}]})).unwrap()
}
fn client(api: &Arc<ApiFixture>, orka: &Arc<OrkaFixture>, auth: Value) -> ClusterClient {
    ClusterClient::new(config(&api.start(), auth), orka.clone())
}
async fn target(client: &mut ClusterClient) -> TargetId {
    let context = client.contexts().unwrap()[0].id;
    client.discover(context).await.unwrap()[0].id
}

#[tokio::test]
async fn creator_bearer_echo_after_serviceaccount_fallback_is_not_exported() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    *orka.identity.lock().unwrap() =
        json!({"authenticated":true,"authType":"tokenReview","namespace":""});
    *orka.providers.lock().unwrap() = Some(
        json!({"items":[{"metadata":{"name":"creator-fixture","namespace":"agents"},"status":{"ready":true}}],"metadata":{"continue":null}}),
    );
    let mut client = client(&api, &orka, json!({"token":"creator-fixture"}));
    let id = target(&mut client).await;
    assert!(matches!(
        client.connect(id, Some("existing".into())).await,
        Err(AccessOutcome::Unavailable)
    ));
    let calls = api.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|c| c.1.ends_with("/token")).count(), 1);
    assert!(calls.iter().all(|c| c.0 == "GET"
        || c.1.ends_with("/token")
        || c.1.ends_with("/selfsubjectaccessreviews")));
}

#[tokio::test]
async fn omitted_provider_readiness_is_false_beside_a_ready_provider() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    *orka.providers.lock().unwrap() = Some(json!({"items":[
        {"metadata":{"name":"ready","namespace":"agents"},"status":{"ready":true}},
        {"metadata":{"name":"pending","namespace":"agents"},"status":{}}
    ],"metadata":{"continue":null}}));
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let id = target(&mut client).await;
    let access = client.connect(id, None).await.unwrap();
    assert_eq!(
        access
            .providers()
            .iter()
            .map(|p| (p.name.as_str(), p.ready))
            .collect::<Vec<_>>(),
        [("ready", true), ("pending", false)]
    );
    *orka.providers.lock().unwrap() = Some(
        json!({"items":[{"metadata":{"name":"invalid","namespace":"agents"},"status":{"ready":"false"}}],"metadata":{"continue":null}}),
    );
    assert!(matches!(
        client.connect(id, None).await,
        Err(AccessOutcome::Unavailable)
    ));
}

#[tokio::test]
async fn contexts_are_offline_and_explicit_discovery_only_gets() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let views = client.contexts().unwrap();
    assert_eq!(
        views.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(),
        ["selected", "exec"]
    );
    assert!(api.calls.lock().unwrap().is_empty());
    let found = client.discover(views[0].id).await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].watched_namespace, "agents");
    assert_eq!(found[0].service_namespace, "control");
    assert_eq!(found[0].image, "ghcr.io/orka-agents/orka:v99");
    assert!(api.calls.lock().unwrap().iter().all(|c| c.0 == "GET"));
    assert!(orka.calls.lock().unwrap().is_empty());
    let serialized = serde_json::to_string(&found).unwrap();
    assert!(!serialized.contains("static-fixture"));
    assert!(!serialized.contains("http://"));
}
#[tokio::test]
async fn unrelated_api_workload_does_not_hide_orka_or_break_revalidation() {
    let api = Arc::new(ApiFixture::default());
    *api.unrelated_api.lock().unwrap() = true;
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let views = client
        .discover(client.contexts().unwrap()[0].id)
        .await
        .unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].service_name, "orka");
    let access = client.connect(views[0].id, None).await.unwrap();
    client.revalidate(&access).await.unwrap();
    assert!(api
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c.0 == "GET" || c.1.ends_with("/selfsubjectaccessreviews")));
}

#[tokio::test]
async fn missing_watch_namespace_is_not_guessed() {
    let api = Arc::new(ApiFixture::default());
    *api.no_watch.lock().unwrap() = true;
    let mut client = client(
        &api,
        &Arc::new(OrkaFixture::default()),
        json!({"token":"static-fixture"}),
    );
    let id = client.contexts().unwrap()[0].id;
    assert_eq!(
        client.discover(id).await.err(),
        Some(ClusterError::Unavailable)
    );
}
#[tokio::test]
async fn static_namespace_bearer_no_tokenrequest_and_same_bearer_permission_check() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(
        &api,
        &orka,
        json!({"token":"static-fixture","exec":{"command":"must-not-execute"}}),
    );
    let id = target(&mut client).await;
    let access = client.connect(id, None).await.unwrap();
    let providers = access.providers();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].name, "model");
    assert!(providers[0].ready);
    access
        .require_builtins(&["web_fetch".into()])
        .await
        .unwrap();
    let calls = api.calls.lock().unwrap();
    assert!(!calls.iter().any(|c| c.1.ends_with("/token")));
    let reviews: Vec<_> = calls
        .iter()
        .filter(|c| c.1.ends_with("/selfsubjectaccessreviews"))
        .collect();
    assert_eq!(reviews.len(), 10);
    assert!(reviews.iter().all(|c| c.2 == "Bearer static-fixture"));
    assert!(reviews.iter().any(
        |c| c.3["spec"]["resourceAttributes"]["resource"] == "agents"
            && c.3["spec"]["resourceAttributes"]["verb"] == "create"
    ));
}
#[tokio::test]
async fn oidc_no_sar_and_denial_does_not_substitute_identity() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    *orka.identity.lock().unwrap() =
        json!({"authenticated":true,"authType":"oidc","namespace":"agents"});
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let id = target(&mut client).await;
    client.connect(id, None).await.unwrap();
    assert!(api.calls.lock().unwrap().iter().all(|c| c.0 == "GET"));
    *orka.fail.lock().unwrap() = Some(AccessOutcome::Denied);
    assert_eq!(
        client.connect(id, Some("existing".into())).await.err(),
        Some(AccessOutcome::Denied)
    );
    assert!(!api
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.1.ends_with("/token")));
}
#[tokio::test]
async fn namespace_less_tokenreview_requests_named_existing_sa_only_on_connect() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    *orka.identity.lock().unwrap() =
        json!({"authenticated":true,"authType":"tokenReview","namespace":""});
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let id = target(&mut client).await;
    assert_eq!(
        client.connect(id, None).await.err(),
        Some(AccessOutcome::NeedServiceAccount)
    );
    assert!(!api
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.1.ends_with("/token")));
    *orka.identity.lock().unwrap() =
        json!({"authenticated":true,"authType":"tokenReview","namespace":"agents"});
    // A namespaced creator no longer needs substitution, even if the caller supplied a name.
    client.connect(id, Some("existing".into())).await.unwrap();
    assert!(!api
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.1.ends_with("/token")));
}
#[tokio::test]
async fn sa_name_not_uri_no_request() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let id = target(&mut client).await;
    let before = api.calls.lock().unwrap().len();
    for bad in [
        "https://host/token",
        "agents/name",
        " name",
        "name:other",
        "",
        "a..b",
        "Bad",
        "-name",
    ] {
        assert_eq!(
            client.connect(id, Some(bad.into())).await.err(),
            Some(AccessOutcome::Unavailable)
        );
    }
    assert_eq!(api.calls.lock().unwrap().len(), before);
    assert!(orka.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn denied_create_reports_denied_no_product_post() {
    let api = Arc::new(ApiFixture::default());
    *api.deny.lock().unwrap() = true;
    let mut client = client(
        &api,
        &Arc::new(OrkaFixture::default()),
        json!({"token":"static-fixture"}),
    );
    let id = target(&mut client).await;
    assert_eq!(
        client.connect(id, None).await.err(),
        Some(AccessOutcome::Denied)
    );
    assert!(api
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c.0 == "GET" || c.1.ends_with("/selfsubjectaccessreviews")));
}
#[tokio::test]
async fn effective_exec_visible_but_unavailable_and_credential_echo_not_exported() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(&api, &orka, json!({"exec":{"command":"must-not-execute"}}));
    let id = client.contexts().unwrap()[0].id;
    assert_eq!(
        client.discover(id).await.err(),
        Some(ClusterError::UnsupportedCredential)
    );
    assert!(api.calls.lock().unwrap().is_empty());
    let mut client = ClusterClient::new(
        config(&api.start(), json!({"token":"static-fixture"})),
        orka.clone(),
    );
    let id = target(&mut client).await;
    *orka.echo.lock().unwrap() = true;
    let result = client.connect(id, None).await;
    assert_eq!(result.err(), Some(AccessOutcome::Unavailable));
}
#[tokio::test]
async fn certificate_creator_existing_sa_and_issued_ssar_has_no_creator_tls_certificate() {
    let api = Arc::new(ApiFixture::default());
    let tls = tls_fixture::TlsFixture::start(&api.start()).await;
    let orka = Arc::new(OrkaFixture::default());
    let mut cfg = config(&tls.server, tls.auth.clone());
    let cluster = cfg.clusters[0].cluster.as_mut().unwrap();
    cluster.certificate_authority_data = Some(tls.ca.clone());
    cluster.tls_server_name = Some("fixture-server".into());
    let mut exec_cfg = cfg.clone();
    exec_cfg.auth_infos[0].auth_info.as_mut().unwrap().exec = Some(kube::config::ExecConfig {
        command: Some("must-not-execute".into()),
        ..Default::default()
    });
    let mut exec_client = ClusterClient::new(exec_cfg, orka.clone());
    let exec_id = exec_client.contexts().unwrap()[0].id;
    assert_eq!(
        exec_client.discover(exec_id).await.err(),
        Some(ClusterError::UnsupportedCredential)
    );
    assert!(api.calls.lock().unwrap().is_empty());
    let mut client = ClusterClient::new(cfg, orka.clone());
    let id = target(&mut client).await;
    assert!(tls.peers.lock().unwrap().iter().all(|peer| *peer));
    assert_eq!(
        client.connect(id, None).await.err(),
        Some(AccessOutcome::NeedServiceAccount)
    );
    assert!(!api
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.1.ends_with("/token")));
    let access = client
        .connect(id, Some("existing.account".into()))
        .await
        .unwrap();
    assert!(access.expiry.is_some());
    let calls = api.calls.lock().unwrap();
    let requests: Vec<_> = calls.iter().filter(|c| c.1.ends_with("/token")).collect();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].1,
        "/api/v1/namespaces/agents/serviceaccounts/existing.account/token"
    );
    assert_eq!(requests[0].3["spec"]["expirationSeconds"], 600);
    assert_eq!(requests[0].3["spec"]["audiences"], json!([]));
    assert!(requests[0].2.is_empty());
    let reviews: Vec<_> = calls
        .iter()
        .enumerate()
        .filter(|(_, c)| c.1.ends_with("/selfsubjectaccessreviews"))
        .collect();
    assert_eq!(reviews.len(), 10);
    for (i, call) in reviews {
        assert_eq!(call.2, "Bearer issued-fixture");
        assert!(
            !tls.peers.lock().unwrap()[i],
            "SSAR TLS request still used creator certificate"
        );
    }
    assert!(orka
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c.1 == "issued-fixture"));
}
#[tokio::test]
async fn stronger_credentials_do_not_run_exec_or_auth_provider_helpers() {
    let api = Arc::new(ApiFixture::default());
    for auth in [
        json!({"client-certificate-data":"invalid","client-key-data":"invalid","exec":{"command":"must-not-execute"}}),
        json!({"token":"static-fixture","auth-provider":{"name":"gcp","config":{"cmd-path":"must-not-execute"}}}),
        json!({"token":"static-fixture","username":"basic","password":"fixture"}),
    ] {
        let mut client = client(&api, &Arc::new(OrkaFixture::default()), auth);
        let id = client.contexts().unwrap()[0].id;
        assert_eq!(
            client.discover(id).await.err(),
            Some(ClusterError::UnsupportedCredential)
        );
    }
    assert!(api.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn namespace_less_bearer_issues_only_after_confirmed_name() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    *orka.identity.lock().unwrap() =
        json!({"authenticated":true,"authType":"tokenReview","namespace":""});
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let id = target(&mut client).await;
    assert_eq!(
        client.connect(id, None).await.err(),
        Some(AccessOutcome::NeedServiceAccount)
    );
    assert!(!api
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.1.ends_with("/token")));
    client.connect(id, Some("existing".into())).await.unwrap();
    let calls = api.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|c| c.1.ends_with("/token")).count(), 1);
    assert!(calls
        .iter()
        .filter(|c| c.1.ends_with("/selfsubjectaccessreviews"))
        .all(|c| c.2 == "Bearer issued-fixture"));
}
#[tokio::test]
async fn token_file_capture_is_frozen_and_unused_exec_never_runs() {
    use std::io::Write as _;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(b"file-fixture").unwrap();
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(
        &api,
        &orka,
        json!({"tokenFile":file.path(),"exec":{"command":"must-not-execute"}}),
    );
    let id = target(&mut client).await;
    let access = client.connect(id, None).await.unwrap();
    std::fs::write(file.path(), b"replacement-fixture").unwrap();
    // kube5 refreshes token files after 50 seconds (60-second cache minus its 10-second margin).
    tokio::time::sleep(std::time::Duration::from_secs(51)).await;
    client.revalidate(&access).await.unwrap();
    assert!(api
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c.2 == "Bearer file-fixture"));
    access
        .require_builtins(&["web_fetch".into()])
        .await
        .unwrap();
    assert!(orka
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c.1 == "file-fixture"));
}
#[tokio::test]
async fn full_api_address_replacement_cannot_revalidate_existing_access() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let server = api.start();
    let cfg = config(&server, json!({"token":"static-fixture"}));
    let mut client = ClusterClient::new(cfg.clone(), orka.clone());
    let id = target(&mut client).await;
    let access = client.connect(id, None).await.unwrap();
    client.revalidate(&access).await.unwrap();
    let mut replacement = cfg;
    replacement.clusters[0].cluster.as_mut().unwrap().server =
        Some(format!("{server}/different-api-root"));
    let changed = ClusterClient::new(replacement, orka);
    let before = api.calls.lock().unwrap().len();
    assert_eq!(
        changed.revalidate(&access).await.err(),
        Some(ClusterError::Unavailable)
    );
    assert_eq!(api.calls.lock().unwrap().len(), before);
}
#[tokio::test]
async fn ssar_http_403_is_denied_and_tokenrequest_503_is_not_retried() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let id = target(&mut client).await;
    *api.override_response.lock().unwrap() = Some((
        "/selfsubjectaccessreviews".into(),
        403,
        json!({"kind":"Status","apiVersion":"v1","status":"Failure","message":"static-fixture","reason":"Forbidden","code":403}),
    ));
    assert_eq!(
        client.connect(id, None).await.err(),
        Some(AccessOutcome::Denied)
    );
    *orka.identity.lock().unwrap() =
        json!({"authenticated":true,"authType":"tokenReview","namespace":""});
    *api.override_response.lock().unwrap() = Some((
        "/token".into(),
        503,
        json!({"kind":"Status","apiVersion":"v1","status":"Failure","message":"issued-fixture","reason":"Unavailable","code":503}),
    ));
    assert_eq!(
        client.connect(id, Some("existing".into())).await.err(),
        Some(AccessOutcome::Unavailable)
    );
    assert_eq!(
        api.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.1.ends_with("/token"))
            .count(),
        1
    );
}
#[tokio::test]
async fn binding_changed_before_access_and_missing_builtin_cannot_pass() {
    let api = Arc::new(ApiFixture::default());
    let orka = Arc::new(OrkaFixture::default());
    let mut client = client(&api, &orka, json!({"token":"static-fixture"}));
    let id = target(&mut client).await;
    let access = client.connect(id, None).await.unwrap();
    *orka.paged.lock().unwrap() = true;
    access
        .require_builtins(&["web_fetch".into()])
        .await
        .unwrap();
    assert!(orka
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.0 == OrkaResource::Tools && c.3.as_deref() == Some("next")));
    assert_eq!(
        access.require_builtins(&["missing".into()]).await.err(),
        Some(ClusterError::MissingTool)
    );
    *api.replacement.lock().unwrap() = true;
    assert_eq!(
        client.connect(id, None).await.err(),
        Some(AccessOutcome::Unavailable)
    );
}
