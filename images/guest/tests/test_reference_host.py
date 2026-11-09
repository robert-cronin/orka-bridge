import importlib
import json
import select
import socket
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace


class ExchangeTests(unittest.TestCase):
    def test_verifier_barrier_uses_actual_serial_marker(self):
        api = importlib.import_module("guest.reference_host")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "serial.log").write_bytes(b'noise\r\nBRIDGE_BASE {"result":"done"}\r\n')
            api.wait_for_verifier(root, SimpleNamespace(poll=lambda: 0), threading.Event(), time.monotonic() + 1)

    def test_partial_verifier_line_cannot_authorize_shutdown(self):
        api = importlib.import_module("guest.reference_host")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "serial.log").write_bytes(b'BRIDGE_BASE {"result":')
            with self.assertRaisesRegex(ValueError, "verifier incomplete"):
                api.wait_for_verifier(root, SimpleNamespace(poll=lambda: 0), threading.Event(), time.monotonic() + 1)

    def test_real_wire_early_then_existing_serve_and_readiness(self):
        try:
            api = importlib.import_module("guest.reference_host")
        except ModuleNotFoundError:
            self.fail("native reference host exchange missing")
        boot = {"installationId": str(uuid.uuid4()), "generation": 1, "bootNonce": str(uuid.uuid4()), "stateCreation": "new", "stateFsUuid": "id", "stateBytes": 34359738368, "hostUtc": 1}
        host, guest = socket.socketpair()
        host.settimeout(2)
        guest.settimeout(2)
        self.addCleanup(host.close)
        self.addCleanup(guest.close)
        received, errors = [], []
        entered, verified = threading.Event(), threading.Event()
        def verification_barrier():
            entered.set()
            if not verified.wait(2):
                raise ValueError("verifier incomplete")
        def exchange():
            try:
                received.extend(api.runtime_exchange(host, boot, before_shutdown=verification_barrier))
            except (ValueError, OSError, KeyError, TypeError) as error:
                errors.append(error)
        thread = threading.Thread(target=exchange, daemon=True)
        thread.start()
        io = guest.makefile("rwb", buffering=0)
        for stage, id_ in (("early", 1), ("serve", 2)):
            hello = {"type": "hello", "body": {"version": 1, "stage": stage, "guestNonce": str(uuid.uuid4()), "acceptedBootNonce": None if stage == "early" else boot["bootNonce"]}}
            io.write(json.dumps(hello).encode() + b"\n")
            request = json.loads(io.readline())
            self.assertEqual(id_, request["body"]["requestId"])
            self.assertEqual("new" if stage == "early" else "existing", request["body"]["body"]["body"]["stateCreation"])
            result = {"type": "result", "body": {"version": 1, "bootNonce": boot["bootNonce"], "requestId": id_, "body": {"op": "ready", "body": {}}}}
            io.write(json.dumps(result).encode() + b"\n")
        request = json.loads(io.readline())
        self.assertEqual("readiness", request["body"]["body"]["op"])
        result["body"]["requestId"] = 3
        result["body"]["body"] = {"op": "infrastructure", "body": {"phase": "cluster-ready", "service": "starting"}}
        io.write(json.dumps(result).encode() + b"\n")
        self.assertTrue(entered.wait(1))
        self.assertEqual([], select.select([guest], [], [], 0.1)[0])
        verified.set()
        request = json.loads(io.readline())
        self.assertEqual("shutdown", request["body"]["body"]["op"])
        result["body"]["requestId"] = 4
        result["body"]["body"] = {"op": "ready", "body": {}}
        io.write(json.dumps(result).encode() + b"\n")
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual([], errors)
        self.assertEqual(6, len(received))

    def readiness_exchange(self, reply, shutdown=False):
        api = importlib.import_module("guest.reference_host")
        boot = {"installationId": str(uuid.uuid4()), "generation": 1, "bootNonce": str(uuid.uuid4()), "stateCreation": "new", "stateFsUuid": "id", "stateBytes": 1, "hostUtc": 1}
        host, guest = socket.socketpair()
        for side in (host, guest):
            side.settimeout(2)
            self.addCleanup(side.close)
        outcome = []
        def exchange():
            try:
                outcome.append(api.runtime_exchange(host, boot, before_shutdown=lambda: None))
            except (ValueError, OSError, KeyError, TypeError) as error:
                outcome.append(error)
        thread = threading.Thread(target=exchange, daemon=True)
        thread.start()
        io = guest.makefile("rwb", buffering=0)
        def answer(id_, body):
            io.readline()
            io.write(json.dumps({"type": "result", "body": {"version": 1, "bootNonce": boot["bootNonce"], "requestId": id_, "body": body}}).encode() + b"\n")
        for stage, id_ in (("early", 1), ("serve", 2)):
            io.write(json.dumps({"type": "hello", "body": {"version": 1, "stage": stage, "guestNonce": str(uuid.uuid4()), "acceptedBootNonce": None if stage == "early" else boot["bootNonce"]}}).encode() + b"\n")
            answer(id_, {"op": "ready", "body": {}})
        answer(3, reply)
        if shutdown:
            answer(4, {"op": "ready", "body": {}})
        thread.join(2)
        self.assertFalse(thread.is_alive())
        return outcome[0]

    def test_failed_or_masked_infrastructure_observation_is_recorded_not_gated(self):
        for phase, service in ((None, "failed"), ("orka-ready", "failed"), ("infrastructure-ready", "ready")):
            frames = self.readiness_exchange({"op": "infrastructure", "body": {"phase": phase, "service": service}}, shutdown=True)
            self.assertEqual(6, len(frames))
            self.assertEqual({"phase": phase, "service": service}, frames[4]["body"]["body"]["body"])

    def test_readiness_rejects_plain_ready_and_invalid_observations(self):
        for reply in ({"op": "ready", "body": {}}, {"op": "infrastructure", "body": {"phase": "bogus", "service": "ready"}},
                      {"op": "infrastructure", "body": {"phase": None, "service": "bogus"}}, {"op": "infrastructure", "body": {"service": "ready"}},
                      {"op": "infrastructure", "body": {"phase": None, "service": "ready", "extra": 1}}):
            self.assertIsInstance(self.readiness_exchange(reply), ValueError)
