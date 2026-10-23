"""Actuators: the sail gearmotor that rotates the mast, and the rudder servo.

Both take exactly what the firmware writes to its timers: sail H-bridge
compare values on TIM2 CH1/CH2 and the rudder pulse width in microseconds on
TIM1 CH3.
"""

import math


class SailDrive:
    """DC gearmotor turning the wing mast.

    Speed is proportional to the H-bridge duty, scaled so the firmware's
    MOTOR_SLOW duty gives the measured ``speed_dps_at_slow``, with a first-order
    spin-up. The gearbox is treated as not back-drivable: the wing stays put
    when the motor is off. Aerodynamic load on the motor is not modelled yet.
    """

    def __init__(self, params, sail_deg=0.0):
        self.drive = params.sail_drive
        self.encoder = params.encoder
        self.sail_deg = sail_deg     # wing chord vs centreline, + trailing edge to port
        self.rate_dps = 0.0          # signed, in sail degrees per second

    def step(self, dt, ch1, ch2):
        # Channel 2 raises the encoder angle when polarity is +1.
        duty = (ch2 - ch1) / self.drive.slow_duty
        encoder_rate = self.drive.polarity * duty * self.drive.speed_dps_at_slow
        target = self.encoder.sign * encoder_rate
        self.rate_dps += (target - self.rate_dps) * min(1.0, dt / self.drive.spin_up_s)
        self.sail_deg = (self.sail_deg + self.rate_dps * dt + 180.0) % 360.0 - 180.0

    @property
    def sail_rad(self):
        return math.radians(self.sail_deg)


class RudderServo:
    """Hobby servo on the rudder: pulse width sets a target angle, reached at a
    limited slew rate. Pulses outside the servo's rated range are counted."""

    def __init__(self, params):
        self.p = params.rudder_servo
        self.angle_deg = 0.0          # + turns the boat to starboard
        self.pulse_us = self.p.centre_us
        self.out_of_range_pulses = 0
        self.min_pulse_us = self.max_pulse_us = None    # over every command received

    def command(self, pulse_us):
        """Called when the firmware writes a new compare value."""
        self.pulse_us = pulse_us
        self.min_pulse_us = pulse_us if self.min_pulse_us is None else min(self.min_pulse_us, pulse_us)
        self.max_pulse_us = pulse_us if self.max_pulse_us is None else max(self.max_pulse_us, pulse_us)
        if not self.p.valid_min_us <= pulse_us <= self.p.valid_max_us:
            self.out_of_range_pulses += 1

    def step(self, dt):
        p = self.p
        target = p.direction * (self.pulse_us - p.centre_us) / p.us_per_deg
        target = max(-p.max_deg, min(p.max_deg, target))
        max_move = p.slew_dps * dt
        self.angle_deg += max(-max_move, min(max_move, target - self.angle_deg))

    @property
    def angle_rad(self):
        return math.radians(self.angle_deg)
