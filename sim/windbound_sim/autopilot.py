"""A stand-in for the Raspberry Pi autopilot.

The real autopilot isn't in this repository. This one speaks the same UART7
protocol so the firmware sees realistic traffic: every period it sends a
TargetsOutput packet with the boat's GPS position and heading plus sail and
rudder targets, and it reads the wind angle the firmware forwards from the
windvane. Its steering is deliberately simple and is not a model of the real
autopilot.

Like the real Pi, it only knows the apparent wind angle (the firmware doesn't
forward wind speed), so upwind it sails by the apparent wind: it holds a
close-hauled apparent angle on one tack and tacks when the waypoint is far
enough to the other side. A tack that hasn't come through the wind after
TACK_TIMEOUT_S is abandoned so the boat can build speed and try again.

Firmware units: sail and rudder targets are degrees in [-45, 45]
(control_logic.c), positive sail swings the trailing edge to port, positive
rudder turns to starboard. Bearings and headings are compass degrees
(clockwise from north); see the open question about RPiSample_t, which
documents target_bearing as East = 0.
"""

import math
from dataclasses import dataclass

SAIL_LIMIT_DEG = 45.0          # control_logic.c maps +/-45 onto the encoder
RUDDER_LIMIT_DEG = 20.0        # a little past rudder stall; more just brakes the boat
RUDDER_GAIN = 0.8              # degrees of rudder per degree of heading error
ANGLE_OF_ATTACK_DEG = 12.0
NO_GO_DEG = 50.0               # sail straight at the waypoint if it's further off the wind
CLOSE_HAULED_AWA_DEG = 40.0    # apparent wind angle held while beating
TACK_MARGIN_DEG = 20.0         # how far past the wind the waypoint must be to tack
TACK_TIMEOUT_S = 20.0
TACK_RETRY_S = 30.0


def wrap180(deg):
    return (deg + 180.0) % 360.0 - 180.0


def bearing_and_distance(origin, frm, to):
    """Compass bearing (degrees) and distance (m) between two lat/lon points."""
    n1, e1 = origin.to_local(*frm)
    n2, e2 = origin.to_local(*to)
    return math.degrees(math.atan2(e2 - e1, n2 - n1)) % 360.0, math.hypot(n2 - n1, e2 - e1)


@dataclass(frozen=True)
class AutopilotPlan:
    """What the stand-in should do: follow waypoints (then circle the last one),
    hold a heading, or send fixed sail/rudder targets (like replaying a recorded RPi)."""

    waypoints: tuple = ()          # ((lat, lon), ...) in order
    heading_deg: float | None = None
    fixed_targets: tuple | None = None   # (sail_deg, rudder_deg)
    arrive_radius_m: float = 10.0


class AutopilotStandIn:
    def __init__(self, plan: AutopilotPlan, origin):
        self.plan = plan
        self.origin = origin
        self.waypoint_index = 0
        self.reached = []              # (index, time_s) for each waypoint reached
        self.wind_side = 0             # beating: +1 wind from starboard, -1 from port, 0 not beating
        self._tack_started_s = None
        self._no_tack_until_s = 0.0

    @property
    def finished(self):
        return bool(self.plan.waypoints) and self.waypoint_index >= len(self.plan.waypoints)

    def update(self, now_s, fix, wind_angle):
        """Return the TargetsOutput packet for this period.

        ``fix``: (lat, lon, heading_deg) from GPS and compass.
        ``wind_angle``: apparent wind angle from the firmware, 0-360 from the bow.
        """
        lat, lon, heading = fix
        target_lat, target_lon = lat, lon
        course = self.plan.heading_deg if self.plan.heading_deg is not None else heading

        if self.plan.waypoints:
            index = min(self.waypoint_index, len(self.plan.waypoints) - 1)
            target_lat, target_lon = self.plan.waypoints[index]
            course, distance = bearing_and_distance(self.origin, (lat, lon), (target_lat, target_lon))
            if distance < self.plan.arrive_radius_m and not self.finished:
                self.reached.append((self.waypoint_index, now_s))
                self.waypoint_index += 1

        if self.plan.fixed_targets is not None:
            sail, rudder = self.plan.fixed_targets
        else:
            awa = wrap180(wind_angle)
            error = self._heading_error(now_s, course, heading, awa)
            rudder = max(-RUDDER_LIMIT_DEG, min(RUDDER_LIMIT_DEG, RUDDER_GAIN * error))
            if error * awa > 0 and abs(error) > abs(awa):
                sail = awa      # turning through the wind: feather the wing so it doesn't push
            else:
                sail = awa - math.copysign(ANGLE_OF_ATTACK_DEG, awa)
            sail = max(-SAIL_LIMIT_DEG, min(SAIL_LIMIT_DEG, sail))

        return ('{"TargetsOutput":[{'
                f'"targetBearing":{course:.1f},'
                f'"waypointLat":{target_lat:.6f},"waypointLon":{target_lon:.6f},'
                f'"targetSailAngle":{sail:.1f},"targetFlapAngle":0,'
                f'"targetRudderAngle":{rudder:.1f},'
                f'"latitude":{lat:.6f},"longitude":{lon:.6f},'
                f'"headingAngle":{heading:.1f},"windAngle":{wind_angle}'
                '}]}')

    def _heading_error(self, now_s, course, heading, awa):
        """Degrees to turn (positive to starboard) to make good ``course``."""
        wind_from = (heading + awa) % 360.0
        off = wrap180(course - wind_from)
        if abs(off) >= NO_GO_DEG:
            self.wind_side = 0
            self._tack_started_s = None
            return wrap180(course - heading)

        if self.wind_side == 0:
            # Start beating on the tack the boat is already on.
            self.wind_side = 1 if awa >= 0 else -1
        if self._tack_started_s is not None:
            if (awa >= 0) == (self.wind_side > 0):
                self._tack_started_s = None                 # through the wind
            elif now_s - self._tack_started_s > TACK_TIMEOUT_S:
                self.wind_side = -self.wind_side            # give up, build speed
                self._tack_started_s = None
                self._no_tack_until_s = now_s + TACK_RETRY_S
        elif self.wind_side * off > TACK_MARGIN_DEG and now_s >= self._no_tack_until_s:
            self.wind_side = -self.wind_side
            self._tack_started_s = now_s

        # Hold the close-hauled apparent angle on the chosen side.
        return awa - self.wind_side * CLOSE_HAULED_AWA_DEG
