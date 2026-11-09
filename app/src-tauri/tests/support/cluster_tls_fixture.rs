use base64::{engine::general_purpose::STANDARD, Engine};
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use rustls::{pki_types::PrivatePkcs8KeyDer, RootCertStore, ServerConfig};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct TlsFixture {
    pub server: String,
    pub auth: Value,
    pub ca: String,
    pub peers: Arc<Mutex<Vec<bool>>>,
    task: tokio::task::JoinHandle<()>,
}
impl TlsFixture {
    pub async fn start(upstream: &str) -> Self {
        let mut params = CertificateParams::new(vec!["fixture-ca".into()]).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let issuer = CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap();
        let server_key = KeyPair::generate().unwrap();
        let server_cert = CertificateParams::new(vec!["fixture-server".into()])
            .unwrap()
            .signed_by(&server_key, &issuer)
            .unwrap();
        let client_key = KeyPair::generate().unwrap();
        let client_cert = CertificateParams::new(vec!["fixture-creator".into()])
            .unwrap()
            .signed_by(&client_key, &issuer)
            .unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(issuer.der().clone()).unwrap();
        let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
            Arc::new(roots),
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .allow_unauthenticated()
        .build()
        .unwrap();
        let tls =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_client_cert_verifier(verifier)
                .with_single_cert(
                    vec![server_cert.der().clone()],
                    PrivatePkcs8KeyDer::from(server_key.serialize_der()).into(),
                )
                .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("https://{}", listener.local_addr().unwrap());
        let upstream = upstream.strip_prefix("http://").unwrap().to_owned();
        let peers = Arc::new(Mutex::new(Vec::new()));
        let observed = peers.clone();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                let upstream = upstream.clone();
                let observed = observed.clone();
                tokio::spawn(async move {
                    let mut tls = acceptor.accept(stream).await.unwrap();
                    let has_certificate = tls
                        .get_ref()
                        .1
                        .peer_certificates()
                        .is_some_and(|c| !c.is_empty());
                    observed.lock().unwrap().push(has_certificate);
                    let mut request = Vec::new();
                    let mut buf = [0; 4096];
                    let end = loop {
                        let n = tls.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&buf[..n]);
                        if let Some(i) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let headers = String::from_utf8(request[..end].to_vec()).unwrap();
                    let len = headers
                        .lines()
                        .find_map(|l| {
                            let (key, value) = l.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    while request.len() < end + len {
                        let n = tls.read(&mut buf).await.unwrap();
                        request.extend_from_slice(&buf[..n]);
                    }
                    let mut upstream = tokio::net::TcpStream::connect(upstream).await.unwrap();
                    upstream.write_all(&request).await.unwrap();
                    let mut response = Vec::new();
                    upstream.read_to_end(&mut response).await.unwrap();
                    tls.write_all(&response).await.unwrap();
                    tls.shutdown().await.unwrap();
                });
            }
        });
        let pem = |tag: &str, data: &[u8]| {
            format!(
                "-----BEGIN {tag}-----\n{}\n-----END {tag}-----\n",
                STANDARD.encode(data)
            )
        };
        Self {
            server,
            auth: json!({"client-certificate-data":STANDARD.encode(pem("CERTIFICATE", client_cert.der())), "client-key-data":STANDARD.encode(pem("PRIVATE KEY", &client_key.serialize_der()))}),
            ca: STANDARD.encode(pem("CERTIFICATE", issuer.der())),
            peers,
            task,
        }
    }
}
impl Drop for TlsFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
