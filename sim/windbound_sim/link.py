"""Ground-station link: a TCP stand-in for the joystick controller's serial port.

The ground station normally reads the controller over its ST-Link COM port.
Here it connects to ``socket://127.0.0.1:5760`` instead and reads the same two
line types the controller prints (the formats parsing.py in the ground station
expects):

    sail=30  rudder=-15  | dropped=0  overruns=0
    XBee RX: {"tb":0,...,"sa":210,}

Lines a client sends in the XBee command format, ``{sa:30,ra:-15}``, become
the operator's command, so a terminal or the ground station can steer the
simulated boat.
"""

import queue
import re
import socket
import threading

DEFAULT_PORT = 5760
XBEE_COMMAND_RE = re.compile(r"\{\s*sa\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*ra\s*:\s*(-?\d+(?:\.\d+)?)\s*\}")


def status_line(sail, rudder):
    """The controller's stick status line."""
    return f"sail={int(sail)}  rudder={int(rudder)}  | dropped=0  overruns=0"


def radio_line(telemetry):
    """The controller's line for a telemetry packet received over the XBee."""
    return f"XBee RX: {telemetry}"


class GroundStationLink:
    def __init__(self, host="127.0.0.1", port=DEFAULT_PORT):
        self._server = socket.create_server((host, port))
        self.host, self.port = self._server.getsockname()[:2]
        self._clients = []
        self._lock = threading.Lock()
        self._commands = queue.Queue()
        threading.Thread(target=self._accept_loop, daemon=True).start()

    @property
    def url(self):
        return f"socket://{self.host}:{self.port}"

    @property
    def client_count(self):
        with self._lock:
            return len(self._clients)

    def send_status(self, sail, rudder):
        self._broadcast(status_line(sail, rudder))

    def send_telemetry(self, line):
        self._broadcast(radio_line(line))

    def commands(self):
        """Operator commands received since the last call, as (sail, rudder)."""
        received = []
        while True:
            try:
                received.append(self._commands.get_nowait())
            except queue.Empty:
                return received

    def close(self):
        self._server.close()
        with self._lock:
            for conn in self._clients:
                conn.close()
            self._clients.clear()

    def _broadcast(self, line):
        data = (line + "\r\n").encode()
        with self._lock:
            for conn in list(self._clients):
                try:
                    conn.sendall(data)
                except OSError:
                    self._clients.remove(conn)
                    conn.close()

    def _accept_loop(self):
        while True:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return              # server closed
            with self._lock:
                self._clients.append(conn)
            threading.Thread(target=self._read_loop, args=(conn,), daemon=True).start()

    def _read_loop(self, conn):
        try:
            for line in conn.makefile("r", encoding="utf-8", errors="replace"):
                match = XBEE_COMMAND_RE.search(line)
                if match:
                    self._commands.put((float(match.group(1)), float(match.group(2))))
        except OSError:
            pass
