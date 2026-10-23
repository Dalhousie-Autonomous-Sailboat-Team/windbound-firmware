"""The world around the boat: wind, position on the earth, and the lake.

Conventions used everywhere in the simulator:
  * positions are metres north and east of the scenario origin;
  * headings and wind directions are degrees clockwise from true north;
  * wind direction is where the wind blows FROM (meteorological).
"""

import math
import random
from dataclasses import dataclass
from pathlib import Path

EARTH_RADIUS_M = 6371000.0


@dataclass(frozen=True)
class Origin:
    """Scenario origin; local north/east metres convert to lat/lon around it."""

    lat: float
    lon: float

    def to_latlon(self, north_m, east_m):
        lat = self.lat + math.degrees(north_m / EARTH_RADIUS_M)
        lon = self.lon + math.degrees(
            east_m / (EARTH_RADIUS_M * math.cos(math.radians(self.lat))))
        return lat, lon

    def to_local(self, lat, lon):
        north = math.radians(lat - self.lat) * EARTH_RADIUS_M
        east = math.radians(lon - self.lon) * EARTH_RADIUS_M * math.cos(math.radians(self.lat))
        return north, east


@dataclass(frozen=True)
class WindSpec:
    """Mean wind plus gusts and slow direction shifts."""

    speed_ms: float
    from_deg: float
    gust_ms: float = 0.0        # standard deviation of speed about the mean
    shift_deg: float = 0.0      # standard deviation of direction about the mean
    gust_time_s: float = 8.0    # how long a gust or shift typically lasts


class Wind:
    """True wind at the boat. Gusts and shifts are mean-reverting random walks
    (Ornstein-Uhlenbeck), seeded so every run of a scenario is identical."""

    def __init__(self, spec: WindSpec, seed=0):
        self.spec = spec
        self._rng = random.Random(seed)
        self._gust = 0.0
        self._shift = 0.0
        self.speed_ms = spec.speed_ms
        self.from_deg = spec.from_deg

    def step(self, dt):
        spec = self.spec
        if spec.gust_ms or spec.shift_deg:
            decay = dt / spec.gust_time_s
            scale = math.sqrt(2.0 * decay)
            self._gust += -self._gust * decay + spec.gust_ms * scale * self._rng.gauss(0, 1)
            self._shift += -self._shift * decay + spec.shift_deg * scale * self._rng.gauss(0, 1)
        self.speed_ms = max(0.0, spec.speed_ms + self._gust)
        self.from_deg = (spec.from_deg + self._shift) % 360.0

    def velocity_ne(self):
        """Air velocity (where it moves TO) as north/east m/s."""
        to = math.radians(self.from_deg + 180.0)
        return self.speed_ms * math.cos(to), self.speed_ms * math.sin(to)


class Lake:
    """Water depth from a ground-station depth grid (lake_depth_maps/<Lake>/depth_grid.npz).

    Same file and lookup rule as the ground station's LakeDepthRaster: NaN cells
    are land, and the nearest cell must be water before interpolating.
    """

    def __init__(self, depth_grid_path):
        import numpy as np  # only needed when a scenario uses a lake

        path = Path(depth_grid_path)
        with np.load(path, allow_pickle=False) as data:
            self.depth = np.asarray(data["depth_m"], dtype=np.float32)
            self.north = float(data["north"])
            self.south = float(data["south"])
            self.west = float(data["west"])
            self.east = float(data["east"])
        self.name = path.parent.name.replace("_", " ")
        self._np = np

    @property
    def centre(self):
        return (self.north + self.south) / 2.0, (self.west + self.east) / 2.0

    def depth_at(self, lat, lon):
        """Depth in metres, or None over land or outside the grid."""
        if not (self.south <= lat <= self.north and self.west <= lon <= self.east):
            return None
        rows, cols = self.depth.shape
        fy = (self.north - lat) / (self.north - self.south) * (rows - 1)
        fx = (lon - self.west) / (self.east - self.west) * (cols - 1)
        if not self._np.isfinite(self.depth[int(round(fy)), int(round(fx))]):
            return None
        x0, y0 = int(fx), int(fy)
        x1, y1 = min(cols - 1, x0 + 1), min(rows - 1, y0 + 1)
        tx, ty = fx - x0, fy - y0
        total = weight_sum = 0.0
        for value, weight in ((self.depth[y0, x0], (1 - tx) * (1 - ty)),
                              (self.depth[y0, x1], tx * (1 - ty)),
                              (self.depth[y1, x0], (1 - tx) * ty),
                              (self.depth[y1, x1], tx * ty)):
            if self._np.isfinite(value) and weight > 0.0:
                total += float(value) * weight
                weight_sum += weight
        return max(0.0, total / weight_sum) if weight_sum > 1e-9 else None
