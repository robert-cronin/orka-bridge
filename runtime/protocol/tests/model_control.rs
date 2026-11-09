use bridge_runtime_protocol::*;
#[test]
fn native_model_selection_rejects_kmx_preflight_errors_before_delivery() {
    for provider in ["", "UPPER", "with.dot", "-start", "end-", &"x".repeat(46)] {
        assert!(!ModelSelection {
            provider: provider.into(),
            model: "gpt-4.1".into()
        }
        .valid());
    }
    for model in [
        "",
        "auto",
        "AUTO",
        "white space",
        "line\n",
        &"x".repeat(257),
    ] {
        assert!(!ModelSelection {
            provider: "copilot".into(),
            model: model.into()
        }
        .valid());
    }
    assert!(ModelSelection {
        provider: "copilot-1".into(),
        model: "gpt-4.1".into()
    }
    .valid());
}
#[test]
fn model_support_can_be_checked_without_loading_or_sending_a_secret() {
    let j = serde_json::json!({"type":"request","body":{"version":VERSION,"bootNonce":Uuid::new_v4(),"requestId":3,"body":{"op":"modelStatus","body":{}}}});
    assert!(
        serde_json::from_value::<Frame>(j).is_ok(),
        "model capability must precede secret access"
    );
}
#[test]
fn model_diagnostics_accept_old_omission_but_refuse_unbounded_vocabulary() {
    let old = serde_json::json!({"phase":"unknown", "connection":null,
        "credential":{"profile":CREDENTIAL_PROFILE,"installed":true,"generation":Uuid::new_v4()}});
    let state: ModelState = serde_json::from_value(old.clone()).unwrap();
    assert!(serde_json::to_value(state)
        .unwrap()
        .get("diagnostic")
        .is_none());
    let mut new = old.clone();
    new["diagnostic"] = serde_json::json!({"classification":"timeout","elapsedMs":60001,
        "exitCode":null,"stage":"gateway","errorCode":"deadline_exceeded","stderr":"Stderr withheld."});
    let state: ModelState = serde_json::from_value(new.clone()).unwrap();
    let frame = Frame::Result(WireResult {
        version: VERSION,
        boot_nonce: Uuid::new_v4(),
        request_id: 1,
        body: ResultBody::ModelState(state),
    });
    assert!(encode(&frame).is_ok());
    for key in ["classification", "stage", "errorCode", "stderr"] {
        let mut bad = new.clone();
        bad["diagnostic"][key] = serde_json::json!("synthetic-private-output");
        assert!(serde_json::from_value::<ModelState>(bad).is_err(), "{key}");
    }
    let mut bad = new.clone();
    bad["diagnostic"]["raw"] = serde_json::json!("synthetic-private-output");
    assert!(serde_json::from_value::<ModelState>(bad).is_err());
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OldState {
        phase: ModelPhase,
        connection: Option<ModelConnection>,
        credential: CredentialState,
    }
    let prior: OldState = serde_json::from_value(old).unwrap();
    assert_eq!(prior.phase, ModelPhase::Unknown);
    assert!(prior.connection.is_none());
    assert!(prior.credential.installed);
    assert!(
        serde_json::from_value::<OldState>(new).is_err(),
        "old reader cannot accept new diagnostics"
    );
}
