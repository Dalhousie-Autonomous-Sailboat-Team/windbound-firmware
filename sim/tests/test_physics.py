"""Sanity checks on the boat model and the sign conventions that connect it to
the firmware. These hold for any reasonable parameter values."""

import math

from windbound_sim.actuators import RudderServo, SailDrive
from windbound_sim.dynamics import BoatState, Hull, apparent_wind
from windbound_sim.sensors import SailEncoder
from windbound_sim.world import Origin

WIND_FROM_NORTH_4MS = (-4.0, 0.0)       # north/east velocity of the air


def sail_by_hand(params, heading_deg, seconds=90.0, sail_limit=45.0):
    """Hold a heading perfectly and trim the wing to 12 degrees angle of attack."""
    hull = Hull(params, BoatState(heading_rad=math.radians(heading_deg)))
    for _ in range(int(seconds / 0.01)):
        hull.state.heading_rad, hull.state.r = math.radians(heading_deg), 0.0
        _, _, awa, _ = apparent_wind(hull.state, WIND_FROM_NORTH_4MS)
        awa_deg = math.degrees(awa)
        sail = max(-sail_limit, min(sail_limit, awa_deg - math.copysign(12.0, awa_deg)))
        hull.step(0.01, WIND_FROM_NORTH_4MS, math.radians(sail), 0.0)
    return hull.state


def test_cannot_sail_straight_into_the_wind(params):
    assert sail_by_hand(params, 0.0).u < 0.05


def test_sails_on_a_reach_and_stays_below_hull_speed(params):
    state = sail_by_hand(params, 90.0)
    hull_speed = 0.4 * math.sqrt(9.81 * params.hull.lwl_m)
    assert 0.3 < state.u < hull_speed
    assert abs(math.degrees(math.atan2(state.v, state.u))) < 10.0     # small leeway


def test_makes_ground_to_windward_close_hauled(params):
    state = sail_by_hand(params, 45.0)
    north, _ = state.velocity_ne()
    assert north > 0.2


def test_positive_rudder_turns_to_starboard(params):
    hull = Hull(params, BoatState(u=1.0))
    for _ in range(200):
        hull.step(0.01, (0.0, 0.0), 0.0, math.radians(10.0))
    assert hull.state.r > 0 and hull.state.heading_deg > 0


def test_channel_two_raises_the_encoder_angle(params):
    """control_logic.c assumes channel 2 increases the AS5600 reading."""
    drive, encoder = SailDrive(params), SailEncoder(params)
    for _ in range(100):
        drive.step(0.01, 0, params.sail_drive.slow_duty)
    assert encoder.reading(drive.sail_deg) > encoder.reading(0.0)


def test_encoder_truncates_to_whole_degrees_like_the_firmware(params):
    encoder = SailEncoder(params)
    assert encoder.reading(0.0) == 180
    assert encoder.reading(30.99) == 210
    assert encoder.reading(-30.2) == 149


def test_rudder_servo_follows_the_firmware_pulse_mapping(params):
    servo = RudderServo(params)
    servo.command(1370 + 400 * 15 // 45)
    for _ in range(100):
        servo.step(0.01)
    assert abs(servo.angle_deg - 15.0) < 0.1


def test_origin_round_trip():
    origin = Origin(44.6925, -63.5530)
    lat, lon = origin.to_latlon(120.0, -75.0)
    north, east = origin.to_local(lat, lon)
    assert abs(north - 120.0) < 1e-6 and abs(east + 75.0) < 1e-6
