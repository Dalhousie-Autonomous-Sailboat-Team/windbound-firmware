"""The ctypes binding against the real firmware library."""

import ctypes

from windbound_sim import firmware
from windbound_sim.autopilot import AutopilotPlan, AutopilotStandIn
from windbound_sim.firmware import Firmware
from windbound_sim.world import Origin

# Fields the ground station's parsing.py displays (TELEMETRY_FIELDS).
GROUND_STATION_FIELDS = {"tb", "tlat", "tlon", "tsa", "tfa", "tra", "clat", "clon", "cb", "wa", "sa"}


def test_struct_layouts_match_the_firmware_build():
    fw = Firmware()
    for c_name, struct in firmware.STRUCTS.items():
        assert fw.lib.Sil_StructSize(c_name.encode()) == ctypes.sizeof(struct), c_name


def test_xbee_command_reaches_the_actuators():
    fw = Firmware()
    fw.set_time(1000)
    assert fw.receive_xbee("{sa:30,ra:-15}\n")
    out = fw.control(1100, encoder_deg=180)
    assert out.xbee_valid and not out.rpi_valid
    assert (out.sail_ch1, out.sail_ch2) == (0, 11000)      # drive toward encoder 210
    assert out.rudder_pulse_us == 1236                      # 1370 - 15/45 * 400


def test_firmware_state_resets_between_simulations():
    fw = Firmware()
    fw.set_time(1000)
    fw.receive_xbee("{sa:30,ra:-15}\n")
    assert not Firmware().control(1100, encoder_deg=180).xbee_valid


def test_packets_longer_than_the_uart_buffers_are_dropped():
    fw = Firmware()
    assert not fw.receive_xbee("{sa:30,ra:-15" + " " * 60 + "}\n")
    assert not fw.receive_rpi('{"TargetsOutput":[{' + " " * 260 + "}]}")


def test_autopilot_packets_fit_the_rpi_buffer_and_parse():
    origin = Origin(-44.123456, -163.123456)                 # longest numbers
    pilot = AutopilotStandIn(AutopilotPlan(waypoints=((-44.1, -163.1),)), origin)
    packet = pilot.update(0.0, (-44.123456, -163.123456, 359.9), 359)
    assert len(packet) <= firmware.RPI_MAX_CHARS
    fw = Firmware()
    assert fw.receive_rpi(packet)


def test_telemetry_line_has_every_ground_station_field():
    fw = Firmware()
    line = fw.telemetry_line(encoder_deg=213)
    keys = {part.split(":")[0].strip('{"') for part in line.strip("{},").split(",")}
    assert keys == GROUND_STATION_FIELDS
    assert '"sa":213' in line


def test_windvane_angle_is_forwarded_to_the_rpi():
    fw = Firmware()
    assert fw.receive_windvane("$IIMWV,45.0,R,7.8,N,A*2B\r\n")
    assert fw.wind_angle_for_rpi() == 45
