"""Scenario tests: the real firmware logic driving the simulated boat.

Tests marked xfail(strict=True) describe how the boat SHOULD behave and fail
today because of a known firmware problem. When the firmware is fixed they
start passing, pytest reports them as XPASS(strict) failures, and the marker
should be removed in the same change.
"""

import json
import math
import re

import pytest

from windbound_sim.sim import find_lake, sail_motor_reversals

CENTRE_PULSE_US = 1370


def at(sim, t_s):
    """The recorded sample nearest to ``t_s``."""
    return min(sim.samples, key=lambda s: abs(s.t_s - t_s))


def heading_error(sample, target_deg):
    return abs((sample.heading_deg - target_deg + 180.0) % 360.0 - 180.0)


# ----- sail control ---------------------------------------------------------- #

def test_sail_step_settles_within_the_dead_band(run_scenario):
    sim = run_scenario("sail-step")
    settled = [s for s in sim.samples if s.t_s >= 2.0]
    assert all(abs(s.sail_deg - 30.0) <= 5.0 for s in settled)       # 4 deg band + encoder truncation
    assert sail_motor_reversals(sim.samples) <= 1


@pytest.mark.xfail(strict=True, reason=(
    "Bang-bang sail control with a 4 deg dead band, a 100 ms encoder and a 50 ms "
    "control loop hunts when the mast turns faster than about 90 deg/s. "
    "Measure sail_drive.speed_dps_at_slow on the bench."))
def test_sail_step_settles_with_a_fast_motor(run_scenario):
    sim = run_scenario("sail-step", sail_drive={"speed_dps_at_slow": 120.0})
    assert sail_motor_reversals(sim.samples) <= 1


# ----- link loss and failures ------------------------------------------------ #

def test_xbee_loss_stops_the_sail_and_centres_the_rudder(run_scenario):
    sim = run_scenario("xbee-loss")        # last packet at 2.0 s, timeout 2 s
    assert at(sim, 3.95).xbee_valid
    after = at(sim, 4.05)
    assert not after.xbee_valid
    assert (after.sail_ch1, after.sail_ch2) == (0, 0)
    assert after.rudder_pulse_us == CENTRE_PULSE_US


@pytest.mark.xfail(strict=True, reason=(
    "EncoderSample_t has no timestamp, so when the AS5600 stops answering the "
    "control loop keeps driving toward a target it can never see."))
def test_encoder_failure_stops_the_sail_motor(run_scenario):
    sim = run_scenario("encoder-failure")  # fails at 1 s, new command at 1.5 s
    assert all(s.sail_ch1 == s.sail_ch2 == 0 for s in sim.samples if s.t_s >= 4.0)


# ----- command arbitration --------------------------------------------------- #

@pytest.mark.xfail(strict=True, reason=(
    "ControlLogic_Evaluate treats an XBee value of exactly 0 as 'no command' "
    "while the RPi is fresh, so the operator can't centre the rudder."))
def test_operator_can_centre_the_rudder_while_the_autopilot_runs(run_scenario):
    sim = run_scenario("operator-centres-rudder")
    assert abs(sim.samples[-1].rudder_deg) < 1.0


@pytest.mark.xfail(strict=True, reason=(
    "-45 deg maps to 970 us with the -130 us trim, below the servo's 1000 us "
    "minimum; BoatControlTask writes the timer without clamping."))
def test_full_rudder_lock_stays_within_the_servo_range(run_scenario):
    sim = run_scenario("full-rudder-lock")
    assert sim.rudder.out_of_range_pulses == 0


# ----- telemetry ------------------------------------------------------------- #

@pytest.mark.xfail(strict=True, reason=(
    "TelemetryTask casts latitude and longitude to int, so the ground station "
    "gets the boat's position to the nearest degree (about 111 km)."))
def test_telemetry_reports_a_usable_position(run_scenario):
    sim = run_scenario("beam-reach", duration_s=12.0, autopilot={"period_ms": 1000})
    _, line = sim.telemetry[-1]
    fields = {k: float(v) for k, v in re.findall(r'"(\w+)":(-?[\d.]+)', line)}
    lat, lon = sim.position_latlon
    assert abs(fields["clat"] - lat) < 1e-4 and abs(fields["clon"] - lon) < 1e-4


@pytest.mark.xfail(strict=True, reason="TelemetryTask ends the JSON object with a trailing comma.")
def test_telemetry_is_valid_json(run_scenario):
    sim = run_scenario("sail-step", duration_s=1.0)
    json.loads(sim.telemetry[0][1])


# ----- sailing with the autopilot stand-in ---------------------------------- #

def test_beam_reach_holds_course_with_a_1hz_autopilot(run_scenario):
    sim = run_scenario("beam-reach", autopilot={"period_ms": 1000})
    later = [s for s in sim.samples if s.t_s >= 30.0]
    assert max(heading_error(s, 0.0) for s in later) < 15.0
    assert sum(s.speed_ms for s in later) / len(later) > 0.5


@pytest.mark.xfail(strict=True, reason=(
    "The firmware's 10 s RPi timeout implies the Pi sends every 5 s. Rudder targets "
    "that old make the heading swing about 55 deg either way; the Pi needs to send "
    "faster, or the heading loop has to move onto the STM32."))
def test_beam_reach_holds_course_at_the_configured_autopilot_rate(run_scenario, params):
    assert params.autopilot.period_ms == 5000
    sim = run_scenario("beam-reach")
    later = [s for s in sim.samples if s.t_s >= 30.0]
    assert max(heading_error(s, 0.0) for s in later) < 15.0


def test_beats_to_an_upwind_waypoint(run_scenario):
    sim = run_scenario("beat", autopilot={"period_ms": 1000})
    assert len(sim.autopilot.reached) == 1


@pytest.mark.skipif(find_lake("Lake_Micmac") is None, reason=(
    "Lake Micmac depth grid not found; set WINDBOUND_LAKE_DIR to the ground "
    "station's lake_depth_maps folder."))
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_lake_micmac_course_without_running_aground(run_scenario, seed):
    sim = run_scenario("micmac-course", scenario={"seed": seed}, autopilot={"period_ms": 1000})
    assert len(sim.autopilot.reached) == 4
    assert sim.grounded_at_s is None
    depths = [s.depth_m for s in sim.samples if s.depth_m is not None]
    assert min(depths) >= sim.params.hull.draft_m
    assert not math.isnan(sum(depths))
