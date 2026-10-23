"""The ground station's view of the boat.

Everything the ground station knows arrives as the joystick controller's
serial lines: its stick status and the telemetry it relays from the XBee.
GroundStation parses them the same way as parsing.py in the desktop ground
station, and is fed either by the simulator (as the link emulator sends them)
or by a real controller over a serial port (a COM port or a socket:// URL).
"""

import re
import threading
import time
from collections import deque

from .link import radio_line, status_line

# Same patterns as parsing.py in the ground station (simpleSailboatGUI).
STATUS_RE = re.compile(
    r"sail\s*=\s*(-?\d+)\s+rudder\s*=\s*(-?\d+)\s*\|\s*"
    r"dropped\s*=\s*(\d+)\s+overruns\s*=\s*(\d+)")
KV_RE = re.compile(r'"([A-Za-z_]\w*)"\s*:\s*(-?\d+(?:\.\d+)?)')

LOG_LINES = 500
RATE_WINDOW_S = 2.0


class GroundStation:
    def __init__(self):
        self._lock = threading.Lock()
        self._reader = None
        self.version = 0
        self.source = {"kind": "sim", "name": "Simulator", "detail": "this service"}
        self._clear()

    def _clear(self):
        self.status = None
        self.status_at = None
        self.telemetry = {}
        self.telemetry_at = None
        self.packets = 0
        self.error = None
        self.lines = deque(maxlen=LOG_LINES)    # (seq, wall time, text)
        self.seq = 0
        self._recent = deque()                  # wall times of lines in the rate window

    # ----- the simulator's controller lines ---------------------------------- #

    def send_status(self, sail, rudder):
        if self.source["kind"] == "sim":
            self.feed(status_line(sail, rudder))

    def send_telemetry(self, line):
        if self.source["kind"] == "sim":
            self.feed(radio_line(line))

    def commands(self):
        return []

    # ----- parsing ----------------------------------------------------------- #

    def feed(self, line, now=None):
        now = time.time() if now is None else now
        with self._lock:
            self.seq += 1
            self.version += 1
            self.lines.append((self.seq, now, line))
            self._recent.append(now)
            match = STATUS_RE.search(line)
            if match:
                sail, rudder, dropped, overruns = (int(g) for g in match.groups())
                self.status = {"sail": sail, "rudder": rudder, "dropped": dropped, "overruns": overruns}
                self.status_at = now
            elif "XBee RX" in line:
                pairs = KV_RE.findall(line.split("XBee RX:", 1)[1])
                if pairs:
                    self.telemetry = {k: float(v) if "." in v else int(v) for k, v in pairs}
                    self.telemetry_at = now
                    self.packets += 1

    def snapshot(self, since_seq=0, now=None):
        """The ground station's state, with the log lines after ``since_seq``."""
        now = time.time() if now is None else now
        with self._lock:
            while self._recent and now - self._recent[0] > RATE_WINDOW_S:
                self._recent.popleft()
            return {
                "source": dict(self.source),
                "error": self.error,
                "status": self.status,
                "status_age_s": None if self.status_at is None else now - self.status_at,
                "telemetry": dict(self.telemetry),
                "telemetry_age_s": None if self.telemetry_at is None else now - self.telemetry_at,
                "packets": self.packets,
                "line_rate": len(self._recent) / RATE_WINDOW_S,
                "seq": self.seq,
                "lines": [[seq, t, text] for seq, t, text in self.lines if seq > since_seq][-200:],
            }

    # ----- where the lines come from ----------------------------------------- #

    def use_simulator(self):
        self._stop_reader()
        with self._lock:
            self.source = {"kind": "sim", "name": "Simulator", "detail": "this service"}
            self._clear()
            self.version += 1

    def connect_serial(self, url, baud=115200):
        """Read a real controller: a COM port name or any pyserial URL."""
        import serial  # only needed for a real controller

        self._stop_reader()
        port = serial.serial_for_url(url, int(baud), timeout=0.2)
        with self._lock:
            self.source = {"kind": "serial", "name": url, "detail": f"{int(baud)} baud"}
            self._clear()
            self.version += 1
        self._reader = _SerialReader(port, self)
        self._reader.start()

    def _stop_reader(self):
        if self._reader:
            self._reader.stop()
            self._reader = None

    def _failed(self, message):
        with self._lock:
            self.error = message
            self.version += 1


class _SerialReader(threading.Thread):
    def __init__(self, port, ground):
        super().__init__(daemon=True)
        self.port, self.ground = port, ground
        self._stopping = threading.Event()

    def run(self):
        import serial

        try:
            while not self._stopping.is_set():
                raw = self.port.readline()
                if raw:
                    line = raw.decode("utf-8", errors="replace").strip("\r\n")
                    if line:
                        self.ground.feed(line)
        except (serial.SerialException, OSError) as exc:
            if not self._stopping.is_set():
                self.ground._failed(f"Lost {self.port.name}: {exc}")
        finally:
            self.port.close()

    def stop(self):
        self._stopping.set()
        self.join(timeout=1.0)


def serial_ports():
    """Serial ports on this computer, ST-Link ports first."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    ports = []
    for p in list_ports.comports():
        desc = p.description or ""
        squashed = desc.lower().replace("-", "").replace(" ", "")
        stlink = "stlink" in squashed or getattr(p, "vid", None) == 0x0483   # ST's USB vendor ID
        ports.append({"device": p.device, "description": desc, "stlink": stlink})
    return sorted(ports, key=lambda p: (not p["stlink"], p["device"]))
