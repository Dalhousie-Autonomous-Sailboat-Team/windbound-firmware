# Windbound simulator

Test Windbound without putting it in the water. The simulator runs the real
firmware logic (`User/Src/control_logic.c`, `app_protocol.c`, `app_state.c`)
against a physics model of the boat, and can serve the ground station the same
serial lines the joystick controller does, so the ground station shows the
simulated boat.

This is Phase 1 of the simulator plan: the firmware's control logic, parsers
and telemetry formatting run in the loop; its UART byte framing, encoder I2C
driver and RTOS timing do not yet.

## Setup

Build the firmware library (the same preset as the host unit tests):

```sh
cmake --preset Host-Tests
cmake --build --preset Host-Tests
```

Then, from this `sim/` folder, create a Python 3.11+ environment:

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt          # Windows: .venv\Scripts\pip ...
```

The simulator finds the library under `build/` automatically, or set
`WINDBOUND_SIL_LIB` to its path. For scenarios on a lake, set
`WINDBOUND_LAKE_DIR` to the ground station's `lake_depth_maps` folder (a
`simpleSailboatGUI` checkout next to this repo is found without it).

## Run

```sh
.venv/bin/python -m windbound_sim serve
```

This starts one local service and opens http://127.0.0.1:8765. Its sidebar has
two groups:

- **Ground station**: *Helm* is the joystick's GUI: the lake map and route,
  the sail and rudder you're sending and what the boat does with them, from
  the joystick or the laptop's keys (W/S sail, A/D rudder, Shift for bigger
  steps, X to stop sending) or a gamepad. *Telemetry* is every field the boat
  reports and the raw line log. It reads the simulator by default; the
  connection button in the top bar switches it to a real controller on a COM
  port or any pyserial URL.
- **Simulator**: *Mission control* is the boat in 3D on the lake, with force,
  wind and motion vectors you can switch on, the camera in Orbit, Chase or
  Top, what the firmware is obeying and why, a timeline of who had control,
  live checks, and the wind and fault switches. *Firmware checks* rebuilds
  the firmware and runs every test (see below).

The sun and moon buttons switch between light and dark. **Stop boat** silences
both links, the only thing that makes the firmware stop the sail and centre
the rudder. The page loads three.js and its font from the internet, so the
first open needs a connection.

`serve` takes `--scenario`, `--speed 1|5|20|max`, `--port`, `--model` and
`--set table.key=value`. The default boat is drawn from `params/windbound.toml`;
to show the real boat, see `models/README.md`.

### Headless

```sh
.venv/bin/python -m windbound_sim list
.venv/bin/python -m windbound_sim run beam-reach
.venv/bin/python -m windbound_sim run sail-step --set sail_drive.speed_dps_at_slow=120
```

Headless runs go as fast as the computer allows (an hour of sailing takes a
few seconds) and print a summary.

### With the desktop ground station

`serve` also offers the joystick controller's serial lines on
`socket://127.0.0.1:5760` (`--link-port 0` turns that off). In the desktop
ground station, pick **Simulator — socket://127.0.0.1:5760** from the COM Port
list and click Connect. Lines typed into the link in the XBee format,
`{sa:20,ra:-10}`, become the operator's joystick command (try
`nc 127.0.0.1 5760`). `run <scenario> --link --speed 5` does the same without
the web app.

## Changing the firmware without the boat

Edit anything under `User/`, then either:

- open **Firmware checks** and press **Rebuild and reload** (or switch on
  *Rebuild on save*). The service recompiles the firmware library, loads
  the new copy without restarting, and restarts the scenario on it, so Mission
  control is now sailing your change. **Run every check** then runs the
  firmware's unit tests and every simulator test against it and lists each
  result, with the commit and the files you've edited;
- or run the tests from the command line:

```sh
.venv/bin/python -m pytest
```

pytest rebuilds the firmware library before it starts, so it always tests the
code as it is now. The tests prove the firmware three ways:

- `tests/test_invariants.py` states rules the control logic and protocol code
  must keep for every input (no fresh link means the motor is off and the
  rudder centred; the motor never drives both channels; it always turns the
  short way; commands parse back to what was sent) and checks each against
  thousands of random inputs, including the tick counter's wrap.
- `tests/test_scenarios.py` sails whole scenarios with the firmware in the
  loop: link loss, encoder failure, the operator taking over, beating to a
  waypoint, the Lake Micmac course without running aground.
- `tests/test_firmware_binding.py`, `test_link.py` and `test_service.py`
  check the binding, the ground-station link and the web service.

Tests marked `xfail(strict=True)` describe how the boat should behave and
currently fail because of a known firmware problem; each says which one. When
the firmware is fixed, the test starts passing, pytest reports an XPASS
failure, and the marker should be removed in the same change.

`.github/workflows/host-tests.yml` runs the firmware's unit tests and these
tests on every push and pull request.

## What's in here

| File | What it does |
|------|--------------|
| `params/windbound.toml` | Every boat number in one place. Values marked PLACEHOLDER are estimates; replace them with measurements. |
| `windbound_sim/firmware.py` | ctypes binding to the firmware library; checks struct layouts against the C build. |
| `windbound_sim/sim.py` | The clock: runs each piece at the firmware's real task periods. |
| `windbound_sim/dynamics.py` | 3-DOF hull with wing, keel and rudder as foils that stall. |
| `windbound_sim/actuators.py` | Sail gearmotor (from TIM2 duty) and rudder servo (from TIM1 pulse). |
| `windbound_sim/sensors.py` | AS5600 encoder, `$IIMWV` windvane, GPS and compass. |
| `windbound_sim/world.py` | Wind with gusts and shifts, lat/lon, lake depth grids. |
| `windbound_sim/autopilot.py` | Stand-in for the Raspberry Pi autopilot, speaking its UART7 protocol. |
| `windbound_sim/link.py` | TCP stand-in for the joystick controller's serial port. |
| `windbound_sim/service.py` | The web app's local server and its API. |
| `windbound_sim/runner.py` | Runs the simulation in real time for the page, with its timeline and live checks. |
| `windbound_sim/groundstation.py` | The ground station's view: parses the controller's lines from the simulator or a serial port. |
| `windbound_sim/proof.py` | Rebuilds and reloads the firmware library and runs the checks for the page. |
| `windbound_sim/web/` | The page: Helm, Telemetry, Mission control (three.js) and Firmware checks. |
| `models/` | Where a `boat.glb` of the real boat goes, and how to make one. |
| `windbound_sim/scenarios.py` | Named scenarios used by the command line and the tests. |
| `sil/sil_runtime.c` | Gives the firmware library a simulator-owned clock. |

Conventions: positions are metres north/east of the scenario origin; headings
and wind directions are degrees clockwise from north (wind is where it blows
from). Sail angle is positive with the trailing edge to port; rudder angle is
positive turning to starboard. Each is converted to firmware units at its port.

Not modelled yet: aerodynamic load on the sail motor, the wing flap, and the
windvane's own lag. Heel is modelled about one axis, with a righting arm from
`hull.gm_m`.
