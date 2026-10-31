"""The localhost service the page runs on: its routes, who may command it, and
that its commands reach the simulator and the ground station."""

import http.client
import json
import threading
import time

import pytest

from windbound_sim.link import GroundStationLink
from windbound_sim.scenarios import SCENARIOS
from windbound_sim.service import WindboundService
from windbound_sim.sim import Simulation


def wait_for(condition, timeout_s=3.0):
    deadline = time.monotonic() + timeout_s
    while not (value := condition()):
        if time.monotonic() > deadline:
            raise TimeoutError
        time.sleep(0.02)
    return value


@pytest.fixture
def service(params):
    service = WindboundService(params, scenario="sail-step", speed=1, port=0)
    threading.Thread(target=service.serve_forever, daemon=True).start()
    yield service
    service.close()


def request(service, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection(service.host, service.port, timeout=5)
    sent = {"Content-Type": "application/json"} if body is not None else {}
    sent.update(headers or {})
    conn.request(method, path, None if body is None else json.dumps(body), sent)
    response = conn.getresponse()
    data = response.read()
    conn.close()
    return response.status, data


def sim_state(service):
    return json.loads(service.runner.snapshot()[1])


# ----- what the page reads ------------------------------------------------------ #

def test_serves_the_page_and_its_files(service):
    status, page = request(service, "GET", "/")
    assert status == 200 and b'id="view-mission"' in page and b'id="view-helm"' in page
    for name in ("app.css", "app.js", "shell.js", "icons.js", "scene3d.js", "world.js", "boat.js", "favicon.svg",
                 "Geist-Variable.woff2", "GeistMono-Variable.woff2", "OFL.txt"):
        assert request(service, "GET", f"/{name}")[0] == 200


@pytest.mark.parametrize("path", ["/../service.py", "/%2e%2e/service.py", "/web/app.js", "/../../pyproject.toml",
                                  "/service.py", "/.gitignore"])
def test_serves_nothing_outside_its_web_folder(service, path):
    assert request(service, "GET", path)[0] == 404


def test_reports_the_scenario_and_the_lake(service):
    status, body = request(service, "GET", "/api/scene")
    scene = json.loads(body)
    assert status == 200 and scene["scenario"]["name"] == "sail-step"
    assert scene["boat"]["hull"]["length_m"] > 0 and scene["boat"]["keel"]["span_m"] > 0
    names = {s["name"] for s in json.loads(request(service, "GET", "/api/scenarios")[1])}
    assert names == set(SCENARIOS)
    assert request(service, "GET", "/api/map")[0] == 200
    assert request(service, "GET", "/api/ports")[0] == 200


def test_streams_the_simulation(service):
    conn = http.client.HTTPConnection(service.host, service.port, timeout=5)
    conn.request("GET", "/api/stream")
    response = conn.getresponse()
    events = []
    while len(events) < 3:
        line = response.fp.readline().decode().strip()
        if line.startswith("event: "):
            events.append(line[7:])
    conn.close()
    assert events[0] == "hello" and "sim" in events


# ----- who may command it --------------------------------------------------------- #

def test_takes_commands_from_its_own_page(service):
    for origin in (None, f"http://127.0.0.1:{service.port}", f"http://localhost:{service.port}"):
        headers = {"Origin": origin} if origin else {}
        assert request(service, "POST", "/api/sim", {"action": "pause"}, headers)[0] == 204


@pytest.mark.parametrize("headers", [
    {"Origin": "https://example.com"},
    {"Origin": "http://127.0.0.1:1"},
    {"Content-Type": "text/plain"},                         # what a cross-site form can send
    {"Content-Type": "application/x-www-form-urlencoded"},
], ids=["another site", "another local port", "a plain-text post", "a form post"])
def test_refuses_commands_from_other_sites(service, headers):
    status, _ = request(service, "POST", "/api/sim", {"action": "pause"}, headers)
    assert status == 403
    assert sim_state(service)["running"]


def test_refuses_requests_addressed_to_another_name(service):
    """A page on attacker.example whose name now points at 127.0.0.1 still sends its own Host."""
    assert request(service, "GET", "/api/scene", headers={"Host": f"attacker.example:{service.port}"})[0] == 421
    status, _ = request(service, "POST", "/api/sim", {"action": "pause"},
                        {"Host": f"attacker.example:{service.port}"})
    assert status == 421 and sim_state(service)["running"]


@pytest.mark.parametrize("area,body", [
    ("sim", {"action": "launch"}),
    ("sim", {"action": "load", "scenario": "nope"}),
    ("sim", {"action": "speed", "speed": 1000}),
    ("sim", {"action": "operator", "sail": "x", "rudder": 0}),
    ("sim", {"action": "fault", "name": "gremlins", "on": True}),
    ("sim", {"action": "autopilot", "period_ms": 1234}),
    ("ground", {"action": "connect"}),
    ("firmware", {"action": "flash"}),
    ("nothing", {"action": "pause"}),
], ids=["unknown action", "unknown scenario", "unknown speed", "non-numeric joystick", "unknown fault",
        "odd autopilot period", "connect without a port", "unknown firmware action", "unknown area"])
def test_rejects_commands_it_cannot_use(service, area, body):
    assert request(service, "POST", f"/api/{area}", body)[0] in (400, 403)


# ----- the commands reach the simulator ------------------------------------------- #

def test_commands_reach_the_simulator(service):
    post = lambda **body: request(service, "POST", "/api/sim", body)
    assert post(action="load", scenario="beam-reach")[0] == 204
    wait_for(lambda: sim_state(service)["scenario"] == "beam-reach")

    post(action="pause")
    wait_for(lambda: not sim_state(service)["running"])
    post(action="operator", sail=20, rudder=-10)
    post(action="step")
    wait_for(lambda: sim_state(service)["state"]["operator"] == [20.0, -10.0])

    post(action="fault", name="encoder_stuck", on=True)
    post(action="step")
    wait_for(lambda: sim_state(service)["state"]["faults"]["encoder_stuck"])

    post(action="autopilot", period_ms=5000)
    wait_for(lambda: sim_state(service)["autopilot_period_ms"] == 5000)
    assert service.runner.sim.params.autopilot.period_ms == 5000

    post(action="stop_boat")
    post(action="speed", speed="max")
    post(action="resume")
    state = wait_for(lambda: (s := sim_state(service)["state"])["sail_source"] == "none" and s)
    assert state["rudder_pulse"] == 1370 and state["sail_motor"] == 0


def test_the_ground_station_reads_the_simulator(service):
    ground = wait_for(lambda: (g := service.ground.snapshot())["telemetry"] and g)
    assert ground["source"]["kind"] == "sim" and ground["status"] is not None
    assert {"sa", "clat", "clon"} <= set(ground["telemetry"])


def test_the_ground_station_reads_a_controller_over_a_serial_url(service):
    pytest.importorskip("serial")
    controller = GroundStationLink(port=0)             # stands in for the joystick controller's port
    try:
        assert request(service, "POST", "/api/ground", {"action": "connect", "url": controller.url})[0] == 204
        wait_for(lambda: controller.client_count == 1)
        Simulation(SCENARIOS["xbee-loss"], link=controller).run(1.5)
        ground = wait_for(lambda: (g := service.ground.snapshot())["telemetry"] and g)
        assert ground["source"] == {"kind": "serial", "name": controller.url, "detail": "115200 baud"}
        assert ground["status"]["sail"] == 20 and ground["telemetry"]["sa"] == 200

        assert request(service, "POST", "/api/ground", {"action": "simulator"})[0] == 204
        assert service.ground.snapshot()["source"]["kind"] == "sim"
    finally:
        controller.close()


def test_a_serial_port_that_will_not_open_is_reported(service):
    pytest.importorskip("serial")
    status, body = request(service, "POST", "/api/ground", {"action": "connect", "url": "socket://127.0.0.1:1"})
    assert status == 409 and json.loads(body)["error"]


def test_the_firmware_watch_can_be_switched(service):
    assert request(service, "POST", "/api/firmware", {"action": "watch", "on": True})[0] == 204
    assert service.proof.snapshot()["watch"]
    assert request(service, "POST", "/api/firmware", {"action": "watch", "on": False})[0] == 204
    assert not service.proof.snapshot()["watch"]
