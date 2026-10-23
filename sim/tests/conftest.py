import dataclasses
import os

import pytest

from windbound_sim.firmware import build_library
from windbound_sim.params import load_params
from windbound_sim.scenarios import SCENARIOS
from windbound_sim.sim import Simulation


def pytest_configure(config):
    # Always test the firmware as it is now: rebuild the library first, so an
    # edit to User/ can't be tested against a stale build. A library named by
    # WINDBOUND_SIL_LIB is used as it is.
    if os.environ.get("WINDBOUND_SIL_LIB"):
        return
    ok, output = build_library()
    if not ok:
        raise pytest.UsageError("The firmware library didn't build:\n" + output[-3000:])


@pytest.fixture
def params():
    return load_params()


@pytest.fixture
def run_scenario(params):
    """Run a named scenario, optionally with parameter or scenario changes:
    ``run_scenario("beat", autopilot={"period_ms": 1000}, scenario={"seed": 2})``."""

    def run(name, scenario=None, duration_s=None, **param_changes):
        sc = SCENARIOS[name]
        if scenario:
            sc = dataclasses.replace(sc, **scenario)
        return Simulation(sc, params.with_changes(**param_changes)).run(duration_s)

    return run
