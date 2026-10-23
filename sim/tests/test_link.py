"""The ground-station link, read the way the ground station reads it: pyserial
opening a socket:// URL, and the line formats from its parsing.py."""

import re
import time

import pytest

from windbound_sim.link import GroundStationLink
from windbound_sim.scenarios import SCENARIOS
from windbound_sim.sim import Simulation

serial = pytest.importorskip("serial")

# Same patterns as parsing.py in the ground station (simpleSailboatGUI).
SAIL_RUDDER_RE = re.compile(
    r"sail\s*=\s*(-?\d+)\s+rudder\s*=\s*(-?\d+)\s*\|\s*"
    r"dropped\s*=\s*(\d+)\s+overruns\s*=\s*(\d+)")
KV_RE = re.compile(r'"([A-Za-z_]\w*)"\s*:\s*(-?\d+(?:\.\d+)?)')


def wait_for(condition, timeout_s=2.0):
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() > deadline:
            raise TimeoutError
        time.sleep(0.01)


@pytest.fixture
def link():
    link = GroundStationLink(port=0)
    yield link
    link.close()


def test_ground_station_reads_status_and_telemetry_over_socket_url(link):
    port = serial.serial_for_url(link.url, timeout=1.0)
    wait_for(lambda: link.client_count == 1)
    Simulation(SCENARIOS["xbee-loss"], link=link).run(2.5)

    lines = []
    while (raw := port.readline()):
        lines.append(raw.decode().strip())
    port.close()

    status = [SAIL_RUDDER_RE.search(line) for line in lines if line.startswith("sail=")]
    telemetry = [line for line in lines if line.startswith("XBee RX:")]
    assert status and all(status)
    assert status[0].groups() == ("20", "-15", "0", "0")
    assert len(telemetry) == 3                              # t = 0, 1, 2 s
    assert dict(KV_RE.findall(telemetry[-1]))["sa"] == "200"


def test_commands_from_the_ground_station_steer_the_boat(link):
    port = serial.serial_for_url(link.url, timeout=1.0)
    wait_for(lambda: link.client_count == 1)
    sim = Simulation(SCENARIOS["sail-step"], link=link)
    port.write(b"{sa:-20,ra:10}\n")
    wait_for(lambda: sim.step() or sim.operator == (-20.0, 10.0))
    sim.run(sim.now_ms / 1000.0 + 2.0)
    port.close()
    assert sim.output.target_rudder_deg == 10.0
    assert sim.output.rudder_pulse_us == 1458      # 1370 + 10/45 * 400 = 1458.9, truncated
