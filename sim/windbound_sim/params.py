"""Boat parameters, loaded from params/windbound.toml.

The TOML file is the only source of values. Each table maps to one dataclass
below; a missing or unknown key is an error, so a typo can't silently change
the boat.
"""

import dataclasses
import tomllib
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PARAMS_PATH = Path(__file__).resolve().parent.parent / "params" / "windbound.toml"


@dataclass(frozen=True)
class HullParams:
    mass_kg: float
    lwl_m: float
    surge_added_mass: float
    sway_added_mass: float
    yaw_inertia_kgm2: float
    resistance_n_per_ms2: float
    lateral_area_m2: float
    cross_flow_cd: float
    yaw_damping_lin: float
    yaw_damping_quad: float
    draft_m: float
    gm_m: float
    roll_inertia_kgm2: float
    roll_damping: float


@dataclass(frozen=True)
class FoilParams:
    area_m2: float
    aspect_ratio: float
    x_m: float          # along the centreline from the CG, + forward
    z_m: float          # height of the centre of effort above the waterline
    stall_deg: float
    cd0: float


@dataclass(frozen=True)
class SailDriveParams:
    speed_dps_at_slow: float
    slow_duty: int
    spin_up_s: float
    polarity: int


@dataclass(frozen=True)
class EncoderParams:
    centre_deg: float
    sign: int
    period_ms: int
    phase_ms: int


@dataclass(frozen=True)
class RudderServoParams:
    centre_us: float
    us_per_deg: float
    slew_dps: float
    max_deg: float
    valid_min_us: float
    valid_max_us: float
    direction: int


@dataclass(frozen=True)
class WindvaneParams:
    period_ms: int
    noise_deg: float


@dataclass(frozen=True)
class NavParams:
    gps_noise_m: float
    heading_noise_deg: float


@dataclass(frozen=True)
class PeriodParams:
    period_ms: int


@dataclass(frozen=True)
class Params:
    hull: HullParams
    wing: FoilParams
    keel: FoilParams
    rudder: FoilParams
    sail_drive: SailDriveParams
    encoder: EncoderParams
    rudder_servo: RudderServoParams
    windvane: WindvaneParams
    nav: NavParams
    operator: PeriodParams
    autopilot: PeriodParams

    def with_changes(self, **tables):
        """Return a copy with some values replaced, e.g.
        ``params.with_changes(sail_drive={"speed_dps_at_slow": 120})``."""
        changed = {}
        for table, values in tables.items():
            section = getattr(self, table)
            _check_keys(type(section), values, table, required=False)
            changed[table] = dataclasses.replace(section, **values)
        return dataclasses.replace(self, **changed)


def load_params(path=DEFAULT_PARAMS_PATH):
    """Load the boat parameters from a TOML file."""
    with open(path, "rb") as f:
        data = tomllib.load(f)
    _check_keys(Params, data, str(path), required=True)
    sections = {}
    for table in dataclasses.fields(Params):
        values = data[table.name]
        _check_keys(table.type, values, f"{path} [{table.name}]", required=True)
        sections[table.name] = table.type(**values)
    return Params(**sections)


def _check_keys(cls, values, where, required):
    names = {f.name for f in dataclasses.fields(cls)}
    unknown = set(values) - names
    missing = names - set(values) if required else set()
    if unknown:
        raise ValueError(f"{where}: unknown key(s): {', '.join(sorted(unknown))}")
    if missing:
        raise ValueError(f"{where}: missing key(s): {', '.join(sorted(missing))}")
