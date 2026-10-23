"""The simulation loop.

One clock drives everything in 5 ms steps. Each piece runs at the period the
real system uses:

    operator (joystick over XBee)      params [operator] period, 1 s
    windvane $IIMWV                     params [windvane] period
    EncoderTask                         100 ms, with a phase offset
    RpiTransmitTask (wind to the RPi)   500 ms
    autopilot (TargetsOutput)           params [autopilot] period
    BoatControlTask                     50 ms
    TelemetryTask                       1 s
    physics                             every 5 ms step
"""

import math
import os
import random
import time
from dataclasses import dataclass
from pathlib import Path

from .actuators import RudderServo, SailDrive
from .autopilot import AutopilotPlan, AutopilotStandIn
from .dynamics import BoatState, Hull, apparent_wind
from .firmware import FIRMWARE_SAIL_CENTER_DEG, REPO_ROOT, ControlOutput, Firmware
from .params import load_params
from .sensors import NavSensors, SailEncoder, Windvane
from .world import Lake, Origin, Wind, WindSpec

STEP_MS = 5
CONTROL_PERIOD_MS = 50        # boat_control.c SAIL_TASK_PERIOD_MS
TELEMETRY_PERIOD_MS = 1000    # app_comms.c TELEMETRY_PERIOD_MS
RPI_TX_PERIOD_MS = 500        # app_comms.c RpiTransmitTask delay
LINK_STATUS_PERIOD_MS = 200
DEPTH_CHECK_PERIOD_MS = 100

LAKE_MICMAC = Origin(44.6905, -63.5530)
FAULTS = ("xbee_silent", "rpi_silent", "encoder_stuck")


@dataclass(frozen=True)
class OperatorCommand:
    """From ``at_s`` on, the joystick sends this sail/rudder command once per
    operator period. ``sail=None`` means it stops transmitting."""

    at_s: float
    sail: float | None
    rudder: float = 0.0


@dataclass(frozen=True)
class Scenario:
    name: str
    title: str
    description: str
    duration_s: float
    wind: WindSpec = WindSpec(0.0, 0.0)
    origin: Origin = LAKE_MICMAC        # the boat starts here
    heading_deg: float = 0.0
    speed_ms: float = 0.0
    operator: tuple = ()                # OperatorCommand, in time order
    autopilot: AutopilotPlan | None = None
    encoder_fails_at_s: float | None = None
    lake: str | None = None             # folder name under lake_depth_maps/
    seed: int = 1


@dataclass(slots=True)
class Sample:
    t_s: float
    north_m: float
    east_m: float
    heading_deg: float
    speed_ms: float
    sail_deg: float              # true wing angle, + trailing edge to port
    encoder_deg: int             # what the firmware believes
    rudder_deg: float            # true rudder angle
    target_sail_deg: float
    target_rudder_deg: float
    sail_ch1: int
    sail_ch2: int
    rudder_pulse_us: int
    xbee_valid: bool
    rpi_valid: bool
    awa_deg: float
    aws_ms: float
    depth_m: float | None


def sail_motor_reversals(samples):
    """How many times the sail motor changed direction; more than one or two
    after a step means the bang-bang controller is hunting."""
    reversals, last = 0, 0
    for s in samples:
        direction = (s.sail_ch2 > 0) - (s.sail_ch1 > 0)
        if direction and last and direction != last:
            reversals += 1
        last = direction or last
    return reversals


def find_lake(name):
    """depth_grid.npz for a lake, from $WINDBOUND_LAKE_DIR (the ground station's
    lake_depth_maps folder) or a sibling simpleSailboatGUI checkout."""
    roots = [Path(os.environ["WINDBOUND_LAKE_DIR"])] if "WINDBOUND_LAKE_DIR" in os.environ else []
    roots.append(REPO_ROOT.parent / "simpleSailboatGUI" / "lake_depth_maps")
    for root in roots:
        path = root / name / "depth_grid.npz"
        if path.is_file():
            return path
    return None


class Simulation:
    def __init__(self, scenario: Scenario, params=None, link=None):
        self.scenario = scenario
        self.params = params or load_params()
        self.link = link
        rng = random.Random(scenario.seed)

        self.firmware = Firmware()
        self.wind = Wind(scenario.wind, seed=scenario.seed)
        self.origin = scenario.origin
        lake_path = find_lake(scenario.lake) if scenario.lake else None
        self.lake = Lake(lake_path) if lake_path else None

        self.hull = Hull(self.params, BoatState(heading_rad=math.radians(scenario.heading_deg),
                                                u=scenario.speed_ms))
        self.sail = SailDrive(self.params)
        self.rudder = RudderServo(self.params)
        self.encoder = SailEncoder(self.params)
        self.windvane = Windvane(self.params, rng)
        self.nav = NavSensors(self.params, rng)
        self.autopilot = AutopilotStandIn(scenario.autopilot, self.origin) if scenario.autopilot else None

        self.now_ms = 0
        self.speed = None               # real-time multiplier while paced, None when headless
        self.output = ControlOutput(False, False, 0.0, 0.0, "none", "none", 0, 0,
                                    round(self.params.rudder_servo.centre_us))
        self.operator = None            # (sail, rudder) the joystick is sending, or None
        self._operator_index = 0
        self._manual = False            # someone took the joystick; the script stops
        self.faults = dict.fromkeys(FAULTS, False)
        self._rpi_wind_angle = 0
        self.depth_m = None
        self.grounded_at_s = None
        self.samples = []
        self.telemetry = []             # (t_s, line) as sent over the radio

    # ----- running --------------------------------------------------------- #

    def run(self, duration_s=None, realtime=False, speed=1.0):
        """Run to the end of the scenario (or ``duration_s``). In real time the
        loop is paced to the wall clock, ``speed`` times faster."""
        end_ms = round((duration_s or self.scenario.duration_s) * 1000)
        start_wall, start_ms = time.monotonic(), self.now_ms
        self.speed = speed if realtime else None
        while self.now_ms < end_ms:
            self.step()
            if realtime and self.now_ms % CONTROL_PERIOD_MS == 0:
                ahead = (self.now_ms - start_ms) / 1000.0 / speed - (time.monotonic() - start_wall)
                if ahead > 0:
                    time.sleep(ahead)
        return self

    # ----- changes while running -------------------------------------------- #

    def set_operator(self, sail, rudder):
        """Take the joystick: send this command from now on, ignoring the script."""
        self.operator = (float(sail), float(rudder))
        self._manual = True

    def release_operator(self):
        """Put the joystick down: stop sending XBee commands."""
        self.operator = None
        self._manual = True

    def set_fault(self, name, on):
        if name not in self.faults:
            raise ValueError(f"unknown fault {name!r}; known: {', '.join(FAULTS)}")
        self.faults[name] = bool(on)

    def set_wind(self, speed_ms=None, from_deg=None, gust_ms=None):
        spec = self.wind.spec
        self.wind.spec = WindSpec(
            spec.speed_ms if speed_ms is None else max(0.0, float(speed_ms)),
            spec.from_deg if from_deg is None else float(from_deg) % 360.0,
            spec.gust_ms if gust_ms is None else max(0.0, float(gust_ms)),
            spec.shift_deg, spec.gust_time_s)

    def set_waypoints(self, waypoints):
        """Give the autopilot a new route: ((lat, lon), ...), sailed in order."""
        plan = AutopilotPlan(waypoints=tuple((float(lat), float(lon)) for lat, lon in waypoints))
        self.autopilot = AutopilotStandIn(plan, self.origin) if plan.waypoints else None

    def step(self):
        t = self.now_ms
        p = self.params
        fw = self.firmware
        fw.set_time(t)
        state = self.hull.state
        wind_ne = self.wind.velocity_ne()
        _, _, awa, aws = apparent_wind(state, wind_ne)

        self._update_operator(t)
        if self.operator is not None and not self.faults["xbee_silent"] and t % p.operator.period_ms == 0:
            sail, rudder = self.operator
            fw.receive_xbee(f"{{sa:{sail:g},ra:{rudder:g}}}\n")

        if self.windvane.due(t):
            fw.receive_windvane(self.windvane.sentence(awa, aws))

        scheduled = self.scenario.encoder_fails_at_s
        self.encoder.stuck = self.faults["encoder_stuck"] or (scheduled is not None and t >= scheduled * 1000)
        if self.encoder.due(t):
            self.encoder.sample(self.sail.sail_deg)

        if t % RPI_TX_PERIOD_MS == 0:
            self._rpi_wind_angle = fw.wind_angle_for_rpi()
        if self.autopilot and not self.faults["rpi_silent"] and t % p.autopilot.period_ms == 0:
            fix = self.nav.fix(self.origin, state)
            fw.receive_rpi(self.autopilot.update(t / 1000.0, fix, self._rpi_wind_angle))

        if t % CONTROL_PERIOD_MS == 0:
            self.output = fw.control(t, self.encoder.latest_deg)
            self.rudder.command(self.output.rudder_pulse_us)

        if t % TELEMETRY_PERIOD_MS == 0:
            line = fw.telemetry_line(self.encoder.latest_deg)
            self.telemetry.append((t / 1000.0, line))
            if self.link:
                self.link.send_telemetry(line)
        if self.link and t % LINK_STATUS_PERIOD_MS == 0:
            sail, rudder = self.operator or (0, 0)
            self.link.send_status(sail, rudder)

        dt = STEP_MS / 1000.0
        self.wind.step(dt)
        self.sail.step(dt, self.output.sail_ch1, self.output.sail_ch2)
        self.rudder.step(dt)
        if self.grounded_at_s is None:
            self.hull.step(dt, wind_ne, self.sail.sail_rad, self.rudder.angle_rad)
        self.now_ms += STEP_MS

        if self.lake and self.now_ms % DEPTH_CHECK_PERIOD_MS == 0:
            self._check_depth()
        if self.now_ms % CONTROL_PERIOD_MS == 0:
            self._record(awa, aws)

    def live_state(self, finished=False):
        """A snapshot for the web app: the boat's true state and the forces on
        it, beside what the firmware believes, commands and listens to."""
        st, out, f = self.hull.state, self.output, self.hull.forces
        flow_u, flow_v, awa, aws = apparent_wind(st, self.wind.velocity_ne())
        lat, lon = self.position_latlon
        xbee_age, rpi_age = self.firmware.link_ages_ms(self.now_ms)
        servo = self.params.rudder_servo
        state = {
            "t": self.now_ms / 1000.0,
            "speed": self.speed,
            "finished": finished,
            "north": st.north_m,
            "east": st.east_m,
            "lat": lat,
            "lon": lon,
            "heading": st.heading_deg,
            "heel": st.heel_deg,
            "speed_ms": st.speed_ms,
            "velocity": [st.u, st.v],
            "flow": [flow_u, flow_v],
            "forces": {
                "wing_lift": [f.wing.lift_u, f.wing.lift_v],
                "wing_drag": [f.wing.drag_u, f.wing.drag_v],
                "keel": [f.keel.u, f.keel.v],
                "rudder": [f.rudder.u, f.rudder.v],
                "hull": [f.resistance_u, f.cross_flow_v],
                "total": [f.total_u, f.total_v],
                "heel_moment": f.heel_moment,
                "yaw_moment": f.yaw_moment,
            },
            "sail_source": out.sail_source,
            "rudder_source": out.rudder_source,
            "faults": dict(self.faults),
            "sail": self.sail.sail_deg,
            "sail_believed": (self.encoder.latest_deg - FIRMWARE_SAIL_CENTER_DEG + 180) % 360 - 180,
            "sail_target": out.target_sail_deg,
            "sail_motor": (out.sail_ch2 > 0) - (out.sail_ch1 > 0),
            "encoder": self.encoder.latest_deg,
            "encoder_stuck": self.encoder.stuck,
            "rudder": self.rudder.angle_deg,
            "rudder_target": out.target_rudder_deg,
            "rudder_pulse": out.rudder_pulse_us,
            "rudder_pulse_ok": servo.valid_min_us <= out.rudder_pulse_us <= servo.valid_max_us,
            "xbee_valid": out.xbee_valid,
            "rpi_valid": out.rpi_valid,
            "xbee_age": xbee_age,
            "rpi_age": rpi_age,
            "operator": self.operator,
            "operator_manual": self._manual,
            "tws": self.wind.speed_ms,
            "twd": self.wind.from_deg,
            "awa": math.degrees(awa),
            "aws": aws,
            "depth": self.depth_m,
            "grounded_at": self.grounded_at_s,
            "waypoint": None,
        }
        if self.autopilot and self.autopilot.plan.waypoints:
            plan = self.autopilot.plan
            index = min(self.autopilot.waypoint_index, len(plan.waypoints) - 1)
            north, east = self.origin.to_local(*plan.waypoints[index])
            state["waypoint"] = {
                "index": index,
                "count": len(plan.waypoints),
                "reached": len(self.autopilot.reached),
                "distance_m": math.hypot(north - st.north_m, east - st.east_m),
                "bearing": math.degrees(math.atan2(east - st.east_m, north - st.north_m)) % 360.0,
            }
        return state

    def _update_operator(self, t):
        commands = () if self._manual else self.scenario.operator
        while (self._operator_index < len(commands)
               and t >= commands[self._operator_index].at_s * 1000):
            cmd = commands[self._operator_index]
            self.operator = None if cmd.sail is None else (cmd.sail, cmd.rudder)
            self._operator_index += 1
        if self.link:
            for sail, rudder in self.link.commands():
                self.set_operator(sail, rudder)

    def _check_depth(self):
        state = self.hull.state
        self.depth_m = self.lake.depth_at(*self.origin.to_latlon(state.north_m, state.east_m))
        too_shallow = self.depth_m is None or self.depth_m < self.params.hull.draft_m
        if too_shallow and self.grounded_at_s is None:
            self.grounded_at_s = self.now_ms / 1000.0
            state.u = state.v = state.r = 0.0

    def _record(self, awa, aws):
        st, out = self.hull.state, self.output
        self.samples.append(Sample(
            self.now_ms / 1000.0, st.north_m, st.east_m, st.heading_deg, st.speed_ms,
            self.sail.sail_deg, self.encoder.latest_deg, self.rudder.angle_deg,
            out.target_sail_deg, out.target_rudder_deg, out.sail_ch1, out.sail_ch2,
            out.rudder_pulse_us, out.xbee_valid, out.rpi_valid,
            math.degrees(awa) % 360.0, aws, self.depth_m))

    # ----- results --------------------------------------------------------- #

    @property
    def position_latlon(self):
        st = self.hull.state
        return self.origin.to_latlon(st.north_m, st.east_m)

    def summary(self):
        s = self.samples
        distance = sum(math.hypot(b.north_m - a.north_m, b.east_m - a.east_m)
                       for a, b in zip(s, s[1:]))
        duration = s[-1].t_s if s else 0.0
        lat, lon = self.position_latlon
        motor_on = sum(1 for x in s if x.sail_ch1 or x.sail_ch2)
        result = {
            "scenario": self.scenario.name,
            "duration_s": round(duration, 1),
            "distance_m": round(distance, 1),
            "mean_speed_ms": round(distance / duration, 2) if duration else 0.0,
            "final_position": (round(lat, 6), round(lon, 6)),
            "final_heading_deg": round(self.hull.state.heading_deg, 1),
            "final_sail_deg": round(self.sail.sail_deg, 1),
            "final_sail_encoder_deg": self.encoder.latest_deg,
            "sail_motor_on_pct": round(100.0 * motor_on / len(s), 1) if s else 0.0,
            "sail_motor_reversals": sail_motor_reversals(s),
            "rudder_pulse_range_us": (self.rudder.min_pulse_us, self.rudder.max_pulse_us),
            "out_of_range_rudder_pulses": self.rudder.out_of_range_pulses,
            "telemetry_lines": len(self.telemetry),
        }
        if self.lake:
            result["lake"] = self.lake.name
            result["grounded_at_s"] = self.grounded_at_s
        if self.autopilot and self.autopilot.plan.waypoints:
            result["waypoints_reached"] = f"{len(self.autopilot.reached)}/{len(self.autopilot.plan.waypoints)}"
        return result
