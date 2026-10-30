"""DAL_MAST's own navigation (the Raspberry Pi's code) sailing the firmware in
the loop. Skipped when no DAL_MAST checkout with nav_core.py, control_law.py
and pcb_protocol.py is found; see windbound_sim/dalmast.py.
"""

import dataclasses
import json
import math

import pytest

from windbound_sim import dalmast
from windbound_sim.scenarios import SCENARIOS
from windbound_sim.sim import Simulation, find_lake

pytestmark = pytest.mark.skipif(dalmast.find_package() is None, reason=(
    "DAL_MAST's navigation not found; set WINDBOUND_DALMAST_DIR to a DAL_MAST checkout "
    "with the nav/corridor-v2, fix/controls and fix/pcb-link work."))


@pytest.fixture(scope="module")
def make():
    return dalmast.factory()


def test_packets_fit_the_firmware_and_carry_every_key(make, params):
    sim = Simulation(SCENARIOS["micmac-course"], params, autopilot=make)
    packet = sim.autopilot.update(0.0, (44.6925, -63.553, 300.0), 87.0)
    assert len(packet) <= 255 and "e-" not in packet
    assert len(json.loads(packet)["TargetsOutput"][0]) == 10


@pytest.mark.parametrize("wind_ms", [3.0, 4.0, 6.0])
@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_beats_to_an_upwind_waypoint(make, params, seed, wind_ms):
    """Every tack gets through the wind, or is given up and tried again."""
    scenario = SCENARIOS["beat"]
    scenario = dataclasses.replace(scenario, seed=seed,
                                   wind=dataclasses.replace(scenario.wind, speed_ms=wind_ms))
    sim = Simulation(scenario, params.with_changes(autopilot={"period_ms": 500}), autopilot=make).run()
    assert len(sim.autopilot.reached) == 1


@pytest.mark.skipif(find_lake("Lake_Micmac") is None, reason="Lake Micmac depth grid not found")
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_lake_micmac_course_without_running_aground(make, params, seed):
    scenario = dataclasses.replace(SCENARIOS["micmac-course"], seed=seed)
    sim = Simulation(scenario, params.with_changes(autopilot={"period_ms": 500}), autopilot=make).run()
    assert len(sim.autopilot.reached) == 4
    assert sim.grounded_at_s is None
    depths = [s.depth_m for s in sim.samples if s.depth_m is not None]
    assert min(depths) >= sim.params.hull.draft_m and not math.isnan(sum(depths))
