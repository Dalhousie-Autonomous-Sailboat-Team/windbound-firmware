"""Properties of the firmware's control logic and protocol code, checked over
thousands of random inputs rather than a few examples.

Each test states a rule the firmware must keep for every input; a seeded
random generator explores the input space, so a failure is reproducible.
Rules the firmware breaks today are xfail(strict=True) with the reason.
"""

import ctypes as C
import math
import random
import re

import pytest

from windbound_sim import firmware as fwmod
from windbound_sim.firmware import (ControlLogicInput, ControlLogicOutput, EncoderSample, Firmware, RPiSample,
                                    XbeeCommand)

CASES = 5000
XBEE_TIMEOUT_MS, RPI_TIMEOUT_MS = 2000, 10000          # control_logic.c
DEAD_BAND_DEG, CENTRE_DEG, CENTRE_US = 4.0, 180.0, 1370
NONE, XBEE, RPI = 0, 1, 2                               # ControlSource_t
U32 = 2 ** 32


@pytest.fixture(scope="module")
def lib():
    return Firmware().lib


def evaluate(lib, now, xbee=None, rpi=None, encoder=180):
    """ControlLogic_Evaluate on one set of inputs. xbee and rpi are
    (sail, rudder, last_updated_ms) or None for never received."""
    inputs = ControlLogicInput(now_ms=now % U32, encoder=EncoderSample(4, encoder))
    if xbee:
        inputs.xbee = XbeeCommand(xbee[0], xbee[1], xbee[2] % U32, True)
    if rpi:
        inputs.rpi = RPiSample(target_sail_angle=rpi[0], target_rudder_angle=rpi[1],
                               last_updated_ms=rpi[2] % U32, ever_received=True)
    out = ControlLogicOutput()
    lib.ControlLogic_Evaluate(C.byref(inputs), C.byref(out))
    return out


def random_link(rng, now, timeout):
    """A link that is fresh, stale, or never heard, with a sometimes-zero command."""
    roll = rng.random()
    if roll < 0.2:
        return None
    age = rng.randrange(0, timeout) if roll < 0.65 else rng.randrange(timeout, timeout * 20)
    value = lambda: 0.0 if rng.random() < 0.25 else round(rng.uniform(-45, 45))
    return (value(), value(), now - age)


def random_inputs(rng):
    now = rng.randrange(0, U32)         # anywhere in the tick counter, including near the wrap
    return now, random_link(rng, now, XBEE_TIMEOUT_MS), random_link(rng, now, RPI_TIMEOUT_MS), rng.randrange(0, 360)


def fresh(link, now, timeout):
    return link is not None and (now - link[2]) % U32 < timeout


# ----- arbitration ----------------------------------------------------------- #

def test_with_no_fresh_link_the_motor_is_off_and_the_rudder_centred(lib):
    rng = random.Random(1)
    for _ in range(CASES):
        now, xbee, rpi, enc = random_inputs(rng)
        if fresh(xbee, now, XBEE_TIMEOUT_MS) or fresh(rpi, now, RPI_TIMEOUT_MS):
            continue
        out = evaluate(lib, now, xbee, rpi, enc)
        assert (out.sail_motor_channel_1_pwm, out.sail_motor_channel_2_pwm) == (0, 0)
        assert out.rudder_pwm == CENTRE_US
        assert out.sail_source == out.rudder_source == NONE


def test_a_link_is_fresh_exactly_until_its_timeout(lib):
    for timeout, link in ((XBEE_TIMEOUT_MS, "xbee"), (RPI_TIMEOUT_MS, "rpi")):
        for now in (5_000, 100_000, U32 - 3, U32 + 2_500):      # the last two straddle the tick wrap
            last = now - (timeout - 1)
            out = evaluate(lib, now, **{link: (10.0, 10.0, last)})
            assert getattr(out, f"{link}_valid"), (link, now)
            out = evaluate(lib, now, **{link: (10.0, 10.0, now - timeout)})
            assert not getattr(out, f"{link}_valid"), (link, now)


def test_the_target_comes_from_the_source_it_reports(lib):
    rng = random.Random(2)
    for _ in range(CASES):
        now, xbee, rpi, enc = random_inputs(rng)
        out = evaluate(lib, now, xbee, rpi, enc)
        x_ok, r_ok = fresh(xbee, now, XBEE_TIMEOUT_MS), fresh(rpi, now, RPI_TIMEOUT_MS)
        for axis, i, source, target in (("sail", 0, out.sail_source, out.target_sail_angle),
                                        ("rudder", 1, out.rudder_source, out.target_rudder_angle)):
            if x_ok and (not r_ok or xbee[i] != 0.0):
                assert source == XBEE and target == xbee[i], axis
            elif r_ok:
                assert source == RPI and target == rpi[i], axis
            else:
                assert source == NONE and target == 0.0, axis


# ----- the sail motor ------------------------------------------------------- #

def test_the_sail_motor_never_drives_both_channels(lib):
    rng = random.Random(3)
    for _ in range(CASES):
        out = evaluate(lib, *random_inputs(rng))
        assert not (out.sail_motor_channel_1_pwm and out.sail_motor_channel_2_pwm)


def test_the_sail_motor_turns_the_short_way_and_holds_inside_the_dead_band(lib):
    rng = random.Random(4)
    for _ in range(CASES):
        now, xbee, rpi, enc = random_inputs(rng)
        out = evaluate(lib, now, xbee, rpi, enc)
        if out.sail_source == NONE:
            continue
        error = ((CENTRE_DEG + out.target_sail_angle) % 360.0 - enc + 180.0) % 360.0 - 180.0
        if error == -180.0:                     # exactly opposite: both ways are equally short
            assert bool(out.sail_motor_channel_1_pwm) != bool(out.sail_motor_channel_2_pwm), enc
        elif error > DEAD_BAND_DEG:
            assert out.sail_motor_channel_2_pwm and not out.sail_motor_channel_1_pwm, (error, enc)
        elif error < -DEAD_BAND_DEG:
            assert out.sail_motor_channel_1_pwm and not out.sail_motor_channel_2_pwm, (error, enc)
        else:
            assert not (out.sail_motor_channel_1_pwm or out.sail_motor_channel_2_pwm), (error, enc)


# ----- the rudder ------------------------------------------------------------- #

def test_the_rudder_pulse_follows_the_target(lib):
    rng = random.Random(5)
    for _ in range(CASES):
        out = evaluate(lib, *random_inputs(rng))
        assert out.rudder_pwm == int(CENTRE_US + out.target_rudder_angle / 45.0 * 400.0)


# ----- the protocol ----------------------------------------------------------- #

def test_xbee_commands_parse_back_to_what_was_sent():
    fw = Firmware()
    rng = random.Random(6)
    cmd = XbeeCommand()
    for _ in range(CASES):
        sail, rudder = round(rng.uniform(-180, 180), rng.choice((0, 1, 2, 4))), round(rng.uniform(-45, 45), rng.choice((0, 1, 4)))
        assert fw.lib.AppProtocol_ParseXbeeCommand(f"{{sa:{sail},ra:{rudder}}}\n".encode(), C.byref(cmd))
        assert math.isclose(cmd.sail_angle, sail, abs_tol=2e-4) and math.isclose(cmd.rud_angle, rudder, abs_tol=2e-4)


def test_rpi_positions_keep_metre_precision():
    fw = Firmware()
    rng = random.Random(7)
    sample = RPiSample()
    for _ in range(200):
        lat, lon = round(rng.uniform(44.68, 44.70), 6), round(rng.uniform(-63.565, -63.545), 6)
        packet = ('{"TargetsOutput":[{"targetBearing":0,"waypointLat":0,"waypointLon":0,"targetSailAngle":0,'
                  f'"targetFlapAngle":0,"targetRudderAngle":0,"latitude":{lat},"longitude":{lon},'
                  '"headingAngle":0,"windAngle":0}]}')
        assert fw.lib.AppProtocol_ParseRpiSample(packet.encode(), C.byref(sample))
        assert abs(sample.current_lat - lat) < 1e-5 and abs(sample.current_lon - lon) < 1e-5   # about a metre


def test_telemetry_always_fits_its_buffer_and_parses_on_the_ground():
    fw = Firmware()
    rng = random.Random(8)
    kv = re.compile(r'"([A-Za-z_]\w*)"\s*:\s*(-?\d+(?:\.\d+)?)')        # parsing.py's pattern
    buf = C.create_string_buffer(fwmod.TELEMETRY_BUF_LEN)
    for _ in range(CASES):
        rpi = RPiSample(*(rng.uniform(-360, 360) for _ in range(10)))
        rpi.target_lat, rpi.current_lat = rng.uniform(-90, 90), rng.uniform(-90, 90)
        rpi.target_lon, rpi.current_lon = rng.uniform(-180, 180), rng.uniform(-180, 180)
        enc = EncoderSample(4, rng.randrange(0, 360))
        assert fw.lib.AppProtocol_FormatTelemetry(buf, len(buf), C.byref(rpi), C.byref(enc))
        fields = dict(kv.findall(buf.value.decode()))
        assert len(fields) == 11 and int(fields["sa"]) == enc.angle
