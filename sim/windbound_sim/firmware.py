"""The real firmware logic, loaded from the windbound_sil shared library.

The library is built from User/Src/control_logic.c, app_protocol.c and
app_state.c by the Host-Tests CMake preset (see sim/README.md). This module
mirrors the C structs with ctypes and reproduces how the firmware's tasks
feed data through those modules:

* UARTParserTask: parse a complete XBee / RPi / windvane message, then store it
  (``receive_*``). Phase 1 hands over whole messages; the byte-by-byte framing
  in app_comms.c is not exercised yet.
* BoatControlTask: read the latest shared state and run ControlLogic_Evaluate
  (``control``).
* TelemetryTask and RpiTransmitTask: format what goes out on the radio and to
  the Raspberry Pi (``telemetry_line``, ``wind_angle_for_rpi``).

The library keeps the firmware's module-level state, so only one Firmware is
live per process; creating one resets that state.
"""

import ctypes as C
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LIBRARY_NAMES = {"darwin": "libwindbound_sil.dylib", "win32": "windbound_sil.dll"}


class WindSample(C.Structure):
    _fields_ = [("direction", C.c_float), ("reference", C.c_char),
                ("speed", C.c_float), ("speed_unit", C.c_char),
                ("status", C.c_char), ("checksum", C.c_char * 3),
                ("timestamp", C.c_uint32)]


class XbeeCommand(C.Structure):
    _fields_ = [("sail_angle", C.c_float), ("rud_angle", C.c_float),
                ("last_updated_ms", C.c_uint32), ("ever_received", C.c_bool)]


class RPiSample(C.Structure):
    _fields_ = [(name, C.c_float) for name in (
        "target_bearing", "target_lat", "target_lon", "target_sail_angle",
        "target_flap_angle", "target_rudder_angle", "current_lat",
        "current_lon", "current_bearing", "current_wind_angle")] + [
        ("last_updated_ms", C.c_uint32), ("ever_received", C.c_bool)]


class EncoderSample(C.Structure):
    _fields_ = [("channel", C.c_uint8), ("angle", C.c_uint16)]


class ControlLogicInput(C.Structure):
    _fields_ = [("now_ms", C.c_uint32), ("xbee", XbeeCommand),
                ("rpi", RPiSample), ("encoder", EncoderSample)]


class ControlLogicOutput(C.Structure):
    _fields_ = [("xbee_valid", C.c_bool), ("rpi_valid", C.c_bool),
                ("target_sail_angle", C.c_float),
                ("target_rudder_angle", C.c_float),
                ("sail_source", C.c_int),
                ("rudder_source", C.c_int),
                ("sail_motor_channel_1_pwm", C.c_uint16),
                ("sail_motor_channel_2_pwm", C.c_uint16),
                ("rudder_pwm", C.c_uint16)]


STRUCTS = {
    "WindSample_t": WindSample,
    "XbeeCommand_t": XbeeCommand,
    "RPiSample_t": RPiSample,
    "EncoderSample_t": EncoderSample,
    "ControlLogicInput_t": ControlLogicInput,
    "ControlLogicOutput_t": ControlLogicOutput,
}

SOURCES = ("none", "xbee", "rpi")      # ControlSource_t, in order
ENCODER_MUX_CHANNEL = 4
TELEMETRY_BUF_LEN = 256
FIRMWARE_SAIL_CENTER_DEG = 180   # control_logic.c SAIL_CENTER_DEG: what the firmware believes is centre

# Longest message each UARTParserTask handler can hold (its buffer minus the
# terminator); anything longer is dropped mid-packet by app_comms.c.
XBEE_MAX_CHARS = 63
RPI_MAX_CHARS = 255
WINDVANE_MAX_CHARS = 63


@dataclass(frozen=True)
class ControlOutput:
    xbee_valid: bool
    rpi_valid: bool
    target_sail_deg: float
    target_rudder_deg: float
    sail_source: str              # "xbee", "rpi" or "none": the link the firmware obeyed
    rudder_source: str
    sail_ch1: int
    sail_ch2: int
    rudder_pulse_us: int


def find_library():
    """Locate the built library: $WINDBOUND_SIL_LIB, else anywhere under build/."""
    override = os.environ.get("WINDBOUND_SIL_LIB")
    if override:
        return Path(override)
    name = LIBRARY_NAMES.get(sys.platform, "libwindbound_sil.so")
    found = sorted((REPO_ROOT / "build").glob(f"**/{name}"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    if not found:
        raise FileNotFoundError(
            f"{name} not found under {REPO_ROOT / 'build'}. Build it first:\n"
            "  cmake --preset Host-Tests\n"
            "  cmake --build --preset Host-Tests\n"
            "or point WINDBOUND_SIL_LIB at the file.")
    return found[0]


def build_library():
    """Build windbound_sil from the current firmware sources, configuring the
    Host-Tests preset first if it hasn't been. Returns (ok, compiler output)."""
    commands = [["cmake", "--build", "--preset", "Host-Tests", "--target", "windbound_sil"]]
    if not (REPO_ROOT / "build" / "Host-Tests").is_dir():
        commands.insert(0, ["cmake", "--preset", "Host-Tests"])
    output = []
    for command in commands:
        try:
            done = subprocess.run(command, cwd=REPO_ROOT, capture_output=True, text=True)
        except FileNotFoundError:
            return False, "cmake was not found on PATH."
        output.append(done.stdout + done.stderr)
        if done.returncode != 0:
            return False, "".join(output)
    return True, "".join(output)


def reload_library():
    """Load a fresh copy of the built library, so firmware edits take effect
    without restarting Python. Firmware objects created afterwards use it."""
    global _library
    built = find_library()
    copy = Path(tempfile.gettempdir()) / f"windbound_sil-{os.getpid()}-{time.time_ns()}{built.suffix}"
    shutil.copy2(built, copy)
    _library = None
    _load(copy)
    try:
        copy.unlink()           # already mapped; Windows keeps it until exit
    except OSError:
        pass
    return built


_library = None


def _load(path):
    global _library
    if _library is None:
        lib = C.CDLL(str(path or find_library()))
        lib.Sil_SetTickCount.argtypes = [C.c_uint32]
        lib.Sil_StructSize.argtypes = [C.c_char_p]
        lib.Sil_StructSize.restype = C.c_uint32
        lib.ControlLogic_Evaluate.argtypes = [C.POINTER(ControlLogicInput),
                                              C.POINTER(ControlLogicOutput)]
        for name, struct in (("Xbee", XbeeCommand), ("RPi", RPiSample), ("Wind", WindSample)):
            getattr(lib, f"{name}_UpdateLatest").argtypes = [C.POINTER(struct)]
            getattr(lib, f"{name}_GetLatest").argtypes = [C.POINTER(struct)]
        for name, struct in (("AppProtocol_ParseXbeeCommand", XbeeCommand),
                             ("AppProtocol_ParseRpiSample", RPiSample),
                             ("AppProtocol_ParseWindNmea", WindSample)):
            parse = getattr(lib, name)
            parse.argtypes = [C.c_char_p, C.POINTER(struct)]
            parse.restype = C.c_bool
        lib.AppProtocol_FormatTelemetry.argtypes = [C.c_char_p, C.c_size_t,
                                                    C.POINTER(RPiSample),
                                                    C.POINTER(EncoderSample)]
        lib.AppProtocol_FormatTelemetry.restype = C.c_bool
        _check_layouts(lib)
        _library = lib
    return _library


def _check_layouts(lib):
    for c_name, struct in STRUCTS.items():
        expected = lib.Sil_StructSize(c_name.encode())
        if expected != C.sizeof(struct):
            raise RuntimeError(
                f"{c_name} is {expected} bytes in the firmware but {C.sizeof(struct)} "
                "in windbound_sim/firmware.py; update the ctypes struct to match the header.")


class Firmware:
    def __init__(self, library_path=None):
        self.lib = _load(library_path)
        self.lib.Sil_Reset()

    def set_time(self, now_ms):
        """Advance the firmware's tick count (osKernelGetTickCount)."""
        self.lib.Sil_SetTickCount(now_ms)

    # ----- UARTParserTask -------------------------------------------------- #

    def receive_xbee(self, packet):
        """A packet from the joystick controller over the XBee, e.g. ``{sa:30,ra:-15}\\n``."""
        cmd = XbeeCommand()
        if len(packet) > XBEE_MAX_CHARS:
            return False
        if not self.lib.AppProtocol_ParseXbeeCommand(packet.encode(), C.byref(cmd)):
            return False
        self.lib.Xbee_UpdateLatest(C.byref(cmd))
        return True

    def receive_rpi(self, packet):
        """A TargetsOutput packet from the Raspberry Pi."""
        sample = RPiSample()
        if len(packet) > RPI_MAX_CHARS:
            return False
        if not self.lib.AppProtocol_ParseRpiSample(packet.encode(), C.byref(sample)):
            return False
        self.lib.RPi_UpdateLatest(C.byref(sample))
        return True

    def receive_windvane(self, sentence):
        """An NMEA sentence from the windvane; only $IIMWV is used."""
        if not sentence.startswith("$IIMWV") or len(sentence) > WINDVANE_MAX_CHARS:
            return False
        sample = WindSample()
        if not self.lib.AppProtocol_ParseWindNmea(sentence.encode(), C.byref(sample)):
            return False
        self.lib.Wind_UpdateLatest(C.byref(sample))
        return True

    # ----- BoatControlTask ------------------------------------------------- #

    def control(self, now_ms, encoder_deg):
        inputs = ControlLogicInput(now_ms=now_ms)
        self.lib.Xbee_GetLatest(C.byref(inputs.xbee))
        self.lib.RPi_GetLatest(C.byref(inputs.rpi))
        inputs.encoder = EncoderSample(ENCODER_MUX_CHANNEL, encoder_deg)
        out = ControlLogicOutput()
        self.lib.ControlLogic_Evaluate(C.byref(inputs), C.byref(out))
        return ControlOutput(out.xbee_valid, out.rpi_valid,
                             out.target_sail_angle, out.target_rudder_angle,
                             SOURCES[out.sail_source], SOURCES[out.rudder_source],
                             out.sail_motor_channel_1_pwm, out.sail_motor_channel_2_pwm,
                             out.rudder_pwm)

    # ----- TelemetryTask / RpiTransmitTask --------------------------------- #

    def telemetry_line(self, encoder_deg):
        """The line TelemetryTask sends over the radio, without its CR LF."""
        rpi = RPiSample()
        self.lib.RPi_GetLatest(C.byref(rpi))
        buf = C.create_string_buffer(TELEMETRY_BUF_LEN)
        encoder = EncoderSample(ENCODER_MUX_CHANNEL, encoder_deg)
        self.lib.AppProtocol_FormatTelemetry(buf, TELEMETRY_BUF_LEN, C.byref(rpi), C.byref(encoder))
        return buf.value.decode().rstrip("\r\n")

    def link_ages_ms(self, now_ms):
        """Milliseconds since the firmware last stored an XBee and an RPi
        message, or None for a link it has never heard."""
        xbee, rpi = XbeeCommand(), RPiSample()
        self.lib.Xbee_GetLatest(C.byref(xbee))
        self.lib.RPi_GetLatest(C.byref(rpi))
        return (now_ms - xbee.last_updated_ms if xbee.ever_received else None,
                now_ms - rpi.last_updated_ms if rpi.ever_received else None)

    def wind_angle_for_rpi(self):
        """The windAngle RpiTransmitTask sends to the Raspberry Pi."""
        sample = WindSample()
        self.lib.Wind_GetLatest(C.byref(sample))
        return int(sample.direction)
