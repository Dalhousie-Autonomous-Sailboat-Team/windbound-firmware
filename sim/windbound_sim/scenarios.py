"""Named scenarios, runnable from the command line and used by the tests.

Operator commands are in firmware units: sail and rudder degrees in [-45, 45].
"""

from .autopilot import AutopilotPlan
from .sim import OperatorCommand, Scenario
from .world import Origin, WindSpec

MICMAC_START = Origin(44.6925, -63.5530)       # deep water in the main basin
MICMAC_COURSE = (
    (44.6948, -63.5555),    # north-west: reach
    (44.6915, -63.5490),    # east: reach
    (44.6878, -63.5505),    # south: beat into the south-west wind
    (44.6925, -63.5535),    # back to the start: reach
)

SCENARIOS = {s.name: s for s in (
    Scenario(
        "sail-step", "Sail step", "Joystick commands the sail from centre to +30 degrees; no wind.",
        duration_s=6.0,
        operator=(OperatorCommand(0.0, sail=30.0),),
    ),
    Scenario(
        "xbee-loss", "XBee loss", "Joystick sends sail 20 / rudder -15, then goes silent at 3 s.",
        duration_s=6.0,
        operator=(OperatorCommand(0.0, sail=20.0, rudder=-15.0), OperatorCommand(3.0, sail=None)),
    ),
    Scenario(
        "encoder-failure", "Encoder failure",
        "The sail encoder stops answering at 1 s; the joystick asks for +30 at 1.5 s.",
        duration_s=12.0,
        operator=(OperatorCommand(0.0, sail=0.0), OperatorCommand(1.5, sail=30.0)),
        encoder_fails_at_s=1.0,
    ),
    Scenario(
        "operator-centres-rudder", "Operator centres the rudder",
        "Autopilot asks for rudder +10; the operator holds sail 25 and centres the rudder.",
        duration_s=4.0,
        operator=(OperatorCommand(0.0, sail=25.0, rudder=0.0),),
        autopilot=AutopilotPlan(fixed_targets=(-30.0, 10.0)),
    ),
    Scenario(
        "full-rudder-lock", "Full rudder lock", "Joystick puts the rudder hard over each way.",
        duration_s=4.0,
        operator=(OperatorCommand(0.0, sail=0.0, rudder=-45.0), OperatorCommand(2.0, sail=0.0, rudder=45.0)),
    ),
    Scenario(
        "beam-reach", "Beam reach", "Autopilot holds north with a 4 m/s easterly on the beam.",
        duration_s=120.0,
        wind=WindSpec(4.0, 90.0),
        autopilot=AutopilotPlan(heading_deg=0.0),
    ),
    Scenario(
        "beat", "Upwind beat", "Autopilot sails to a waypoint 150 m dead upwind in 4 m/s.",
        duration_s=900.0,
        wind=WindSpec(4.0, 0.0),
        origin=MICMAC_START,
        heading_deg=300.0,
        autopilot=AutopilotPlan(waypoints=(MICMAC_START.to_latlon(150.0, 0.0),)),
    ),
    Scenario(
        "micmac-course", "Lake Micmac course",
        "Four-leg course on Lake Micmac in a gusty south-westerly, with depth checks.",
        duration_s=3600.0,
        wind=WindSpec(4.0, 225.0, gust_ms=0.8, shift_deg=10.0),
        origin=MICMAC_START,
        heading_deg=315.0,
        autopilot=AutopilotPlan(waypoints=MICMAC_COURSE),
        lake="Lake_Micmac",
    ),
)}
