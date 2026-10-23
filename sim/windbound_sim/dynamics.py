"""Boat dynamics: surge, sway and yaw in the plane, plus heel.

Body frame: u forward, v to starboard, yaw rate r positive turning to
starboard (clockwise from above). Angles in the body frame are measured
clockwise from the bow. Heel is positive leaning to starboard.

The wing, keel and rudder are all foils: each sees a flow, has an angle of
attack, and produces lift across the flow and drag along it. Lift is linear
up to stall and blends into flat-plate behaviour past it, so a wing sheeted
too tight or a rudder at full lock stalls instead of producing endless force.

Each foil's side force acts at its own height (params ``z_m``), so the wing
above the waterline and the keel below it heel the boat to leeward together;
ballast (``gm_m``) rights it. A heeled wing presents less of itself to the
wind, so its force falls with cos^2 of the heel.
"""

import math
from dataclasses import dataclass, field

RHO_AIR = 1.225
RHO_WATER = 1000.0
GRAVITY = 9.81


def wrap_pi(a):
    """Wrap an angle in radians to (-pi, pi]."""
    return math.atan2(math.sin(a), math.cos(a))


def foil_coefficients(alpha, foil):
    """Lift and drag coefficients at angle of attack ``alpha`` (radians)."""
    a = wrap_pi(alpha)
    ar = foil.aspect_ratio
    slope = 2.0 * math.pi * ar / (ar + 2.0)          # finite-wing lift slope
    cl_attached = slope * a
    cd_attached = foil.cd0 + cl_attached ** 2 / (math.pi * ar * 0.9)
    cl_plate = 0.9 * math.sin(2.0 * a)                 # flat plate, normal force 1.8 sin(a)
    cd_plate = foil.cd0 + 1.8 * math.sin(a) ** 2
    stalled = 1.0 / (1.0 + math.exp(-(abs(a) - math.radians(foil.stall_deg)) / math.radians(2.0)))
    return ((1.0 - stalled) * cl_attached + stalled * cl_plate,
            (1.0 - stalled) * cd_attached + stalled * cd_plate)


@dataclass(frozen=True)
class FoilForce:
    """Lift and drag on one foil, in the body frame (newtons)."""

    lift_u: float = 0.0
    lift_v: float = 0.0
    drag_u: float = 0.0
    drag_v: float = 0.0

    @property
    def u(self):
        return self.lift_u + self.drag_u

    @property
    def v(self):
        return self.lift_v + self.drag_v

    def scaled(self, k):
        return FoilForce(self.lift_u * k, self.lift_v * k, self.drag_u * k, self.drag_v * k)


def foil_force(flow_u, flow_v, chord_angle, foil, rho):
    """Lift and drag on a foil.

    ``flow_u, flow_v``: fluid velocity relative to the foil (where it moves to).
    ``chord_angle``: direction from leading to trailing edge, clockwise from the bow.
    """
    speed = math.hypot(flow_u, flow_v)
    if speed < 1e-6:
        return FoilForce()
    alpha = wrap_pi(math.atan2(flow_v, flow_u) - chord_angle)
    cl, cd = foil_coefficients(alpha, foil)
    q_area = 0.5 * rho * speed * foil.area_m2           # times speed again below
    # Drag along the flow; lift across it, the flow turned 90 degrees.
    return FoilForce(-q_area * cl * flow_v, q_area * cl * flow_u,
                     q_area * cd * flow_u, q_area * cd * flow_v)


@dataclass
class BoatState:
    north_m: float = 0.0
    east_m: float = 0.0
    heading_rad: float = 0.0
    u: float = 0.0
    v: float = 0.0
    r: float = 0.0
    heel_rad: float = 0.0
    p: float = 0.0                 # heel rate

    @property
    def heading_deg(self):
        return math.degrees(self.heading_rad) % 360.0

    @property
    def heel_deg(self):
        return math.degrees(self.heel_rad)

    @property
    def speed_ms(self):
        return math.hypot(self.u, self.v)

    def velocity_ne(self):
        c, s = math.cos(self.heading_rad), math.sin(self.heading_rad)
        return self.u * c - self.v * s, self.u * s + self.v * c


@dataclass(frozen=True)
class Forces:
    """Every force on the boat in the last step, body frame (newtons and N·m)."""

    wing: FoilForce = field(default_factory=FoilForce)
    keel: FoilForce = field(default_factory=FoilForce)
    rudder: FoilForce = field(default_factory=FoilForce)
    resistance_u: float = 0.0      # hull drag along the boat
    cross_flow_v: float = 0.0      # hull drag across it
    yaw_moment: float = 0.0
    heel_moment: float = 0.0       # from the foils' side forces, before ballast

    @property
    def total_u(self):
        return self.wing.u + self.keel.u + self.rudder.u + self.resistance_u

    @property
    def total_v(self):
        return self.wing.v + self.keel.v + self.rudder.v + self.cross_flow_v


def apparent_wind(state, wind_ne):
    """Apparent wind at the mast: (flow_u, flow_v) of the air relative to the boat,
    plus the apparent wind angle (where it comes FROM, radians clockwise from the
    bow, in (-pi, pi]) and speed."""
    wn, we = wind_ne
    c, s = math.cos(state.heading_rad), math.sin(state.heading_rad)
    flow_u = wn * c + we * s - state.u
    flow_v = -wn * s + we * c - state.v
    return flow_u, flow_v, math.atan2(-flow_v, -flow_u), math.hypot(flow_u, flow_v)


class Hull:
    """Integrates the boat's motion from the forces on it."""

    def __init__(self, params, state=None):
        self.p = params
        self.state = state or BoatState()
        hull = params.hull
        self.m_u = hull.mass_kg * (1.0 + hull.surge_added_mass)
        self.m_v = hull.mass_kg * (1.0 + hull.sway_added_mass)
        self.hull_speed = 0.4 * math.sqrt(GRAVITY * hull.lwl_m)
        self.forces = Forces()

    def compute_forces(self, wind_ne, sail_rad, rudder_rad):
        """All forces for the current state.

        ``sail_rad``: wing chord angle from the centreline, positive with the
        trailing edge to port. ``rudder_rad``: positive turns the boat to starboard.
        """
        p, st = self.p, self.state
        hull = p.hull

        flow_u, flow_v, _, _ = apparent_wind(st, wind_ne)
        wing = foil_force(flow_u, flow_v, math.pi + sail_rad, p.wing, RHO_AIR)
        wing = wing.scaled(math.cos(st.heel_rad) ** 2)
        keel = foil_force(-st.u, -st.v, math.pi, p.keel, RHO_WATER)
        rudder_v = st.v + st.r * p.rudder.x_m
        rudder = foil_force(-st.u, -rudder_v, math.pi - rudder_rad, p.rudder, RHO_WATER)

        speed = abs(st.u)
        resistance = -hull.resistance_n_per_ms2 * st.u * speed * (1.0 + (speed / self.hull_speed) ** 4)
        cross_flow = -0.5 * RHO_WATER * hull.lateral_area_m2 * hull.cross_flow_cd * st.v * abs(st.v)

        yaw = (p.wing.x_m * wing.v + p.keel.x_m * keel.v + p.rudder.x_m * rudder.v
               - hull.yaw_damping_lin * st.r - hull.yaw_damping_quad * st.r * abs(st.r))
        heel = p.wing.z_m * wing.v + p.keel.z_m * keel.v + p.rudder.z_m * rudder.v
        return Forces(wing, keel, rudder, resistance, cross_flow, yaw, heel)

    def step(self, dt, wind_ne, sail_rad, rudder_rad):
        f = self.forces = self.compute_forces(wind_ne, sail_rad, rudder_rad)
        st, hull = self.state, self.p.hull
        du = (f.total_u + self.m_v * st.v * st.r) / self.m_u
        dv = (f.total_v - self.m_u * st.u * st.r) / self.m_v
        dr = f.yaw_moment / hull.yaw_inertia_kgm2
        righting = hull.mass_kg * GRAVITY * hull.gm_m * math.sin(st.heel_rad)
        dp = (f.heel_moment - righting - hull.roll_damping * st.p) / hull.roll_inertia_kgm2
        st.u += du * dt
        st.v += dv * dt
        st.r += dr * dt
        st.p += dp * dt
        st.heel_rad += st.p * dt
        vn, ve = st.velocity_ne()
        st.north_m += vn * dt
        st.east_m += ve * dt
        st.heading_rad = wrap_pi(st.heading_rad + st.r * dt)
