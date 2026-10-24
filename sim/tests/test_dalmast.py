"""DAL_MAST's own navigation (the Raspberry Pi's code) sailing the firmware in
the loop. Skipped when no DAL_MAST checkout with nav_core.py, control_law.py
and pcb_protocol.py is found; see windbound_sim/dalmast.py.

Tests marked xfail(strict=True) describe how the boat SHOULD behave and fail
today because of a known problem in DAL_MAST's navigation; remove the marker
when it is fixed.
"""

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


@pytest.mark.xfail(strict=True, reason=(
    "A tack can stall head to wind and never recover: the wing stays trimmed for the old tack "
    "while the boat turns (controls has no feathering through the wind), and navigation never "
    "abandons a tack that doesn't come through, so the boat sits ~15 degrees off the wind with "
    "full rudder for the rest of the run."))
def test_beats_to_an_upwind_waypoint(make, params):
    sim = Simulation(SCENARIOS["beat"], params.with_changes(autopilot={"period_ms": 500}),
                     autopilot=make).run()
    assert len(sim.autopilot.reached) == 1


@pytest.mark.skipif(find_lake("Lake_Micmac") is None, reason="Lake Micmac depth grid not found")
def test_lake_micmac_course_without_running_aground(make, params):
    sim = Simulation(SCENARIOS["micmac-course"], params.with_changes(autopilot={"period_ms": 500}),
                     autopilot=make).run()
    assert len(sim.autopilot.reached) == 4
    assert sim.grounded_at_s is None
    depths = [s.depth_m for s in sim.samples if s.depth_m is not None]
    assert min(depths) >= sim.params.hull.draft_m and not math.isnan(sum(depths))
