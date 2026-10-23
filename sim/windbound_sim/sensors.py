"""Sensors, each producing what the real device sends.

* SailEncoder: the AS5600 on the mast, read by the firmware's EncoderTask.
* Windvane: the $IIMWV NMEA sentence on USART3.
* NavSensors: GPS fix and compass heading, which today reach the firmware
  through the Raspberry Pi autopilot rather than directly.
"""

import math
import random

AS5600_COUNTS = 4096


class SailEncoder:
    """AS5600 angle as the firmware stores it.

    EncoderTask reads the 12-bit count and converts it with
    ``(raw / 4096.0f) * 360.0f`` into a ``uint16_t``, which truncates to whole
    degrees. If the I2C read fails, EncoderTask keeps the last value, so a
    ``stuck`` encoder just stops updating.
    """

    def __init__(self, params):
        self.p = params.encoder
        self.latest_deg = self.reading(0.0)
        self.stuck = False

    def reading(self, sail_deg):
        angle = (self.p.centre_deg + self.p.sign * sail_deg) % 360.0
        raw = int(angle / 360.0 * AS5600_COUNTS) % AS5600_COUNTS
        return int(raw / AS5600_COUNTS * 360.0)

    def due(self, now_ms):
        return now_ms % self.p.period_ms == self.p.phase_ms % self.p.period_ms

    def sample(self, sail_deg):
        if not self.stuck:
            self.latest_deg = self.reading(sail_deg)


def nmea_checksum(body):
    value = 0
    for ch in body:
        value ^= ord(ch)
    return f"{value:02X}"


class Windvane:
    """Masthead windvane sending apparent wind as an $IIMWV sentence."""

    def __init__(self, params, rng: random.Random):
        self.p = params.windvane
        self.rng = rng

    def due(self, now_ms):
        return now_ms % self.p.period_ms == 0

    def sentence(self, awa_rad, aws_ms):
        """Apparent wind angle clockwise from the bow (0-360) and speed in knots."""
        angle = (math.degrees(awa_rad) + self.rng.gauss(0.0, self.p.noise_deg)) % 360.0
        body = f"IIMWV,{angle:.1f},R,{aws_ms * 1.943844:.1f},N,A"
        return f"${body}*{nmea_checksum(body)}\r\n"


class NavSensors:
    """GPS position and compass heading with noise."""

    def __init__(self, params, rng: random.Random):
        self.p = params.nav
        self.rng = rng

    def fix(self, origin, state):
        sigma = self.p.gps_noise_m
        lat, lon = origin.to_latlon(state.north_m + self.rng.gauss(0.0, sigma),
                                    state.east_m + self.rng.gauss(0.0, sigma))
        heading = (state.heading_deg + self.rng.gauss(0.0, self.p.heading_noise_deg)) % 360.0
        return lat, lon, heading
