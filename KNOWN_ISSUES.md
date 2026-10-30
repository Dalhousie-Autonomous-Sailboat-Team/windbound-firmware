# Known firmware issues

**8 things the firmware gets wrong today.** The simulator finds every one of them, and each has a test that will tell you when it's fixed.

> **Short on time?** Read the table, then fix the 🔴 ones first.

| # | What goes wrong | How bad | Fixed yet? |
|---|---|---|---|
| 1 | [Sail motor keeps running when its encoder dies](#1-sail-motor-keeps-running-when-its-encoder-dies) | 🔴 safety | ❌ no |
| 2 | [You can't centre the rudder while the autopilot is on](#2-you-cant-centre-the-rudder-while-the-autopilot-is-on) | 🔴 safety | ❌ no |
| 3 | [Full left rudder sends a pulse the servo can't take](#3-full-left-rudder-sends-a-pulse-the-servo-cant-take) | 🟠 hardware | ✅ branch `fix/rudder-pulse-limits` |
| 4 | [The sail can hunt back and forth](#4-the-sail-can-hunt-back-and-forth) | 🟡 maybe | 📏 measure first |
| 5 | [Positions from the Pi are rounded to ~11 m](#5-positions-from-the-pi-are-rounded-to-11-m) | 🟠 navigation | ✅ branch `fix/rpi-link` |
| 6 | [The Pi only has to talk every 5 s, which is too slow to steer](#6-the-pi-only-has-to-talk-every-5-s-which-is-too-slow-to-steer) | 🟠 navigation | 🟡 half done |
| 7 | [The ground station sees the boat's position to the nearest degree](#7-the-ground-station-sees-the-boats-position-to-the-nearest-degree) | 🟠 telemetry | ❌ no |
| 8 | [Telemetry isn't valid JSON](#8-telemetry-isnt-valid-json) | 🟡 telemetry | ❌ no |

🔴 could hurt the boat or someone near it · 🟠 breaks a feature · 🟡 annoying, or might not matter on the real boat

> **About the two "branch" fixes:** they're on this laptop only, not committed and not pushed. Ask before you look for them on GitHub.

---

## How to check them yourself

```bash
sim/.venv/bin/python -m pytest sim -rx
```

Every issue shows up as **XFAIL** with a one-line reason. That means "this test describes the right behaviour, and the firmware fails it, like we expect."

When you fix one, its test **passes**. pytest then shouts **XPASS(strict)** and the run fails on purpose. Go delete the `@pytest.mark.xfail(...)` line above that test, in the same commit as your fix.

Or click **Run every check** in the simulator's *Firmware checks* page.

---

## 1. Sail motor keeps running when its encoder dies

🔴 **Safety.**

**What happens:** the AS5600 (the sail's angle sensor) stops answering. The motor keeps driving toward a target it can't see anymore, and it never stops.

**Why you care:** the mast can spin into its end stop, or wind up its cables, and nothing stops it.

**Why it happens:** `EncoderSample_t` (`User/Inc/encoder.h`) holds an angle and nothing else, with no "when was this read". So the control loop can't tell a fresh reading from one that's 10 minutes old.

**Fix idea:**
- Add `last_updated_ms` to `EncoderSample_t`, and stamp it every time the encoder task gets a reading.
- In `ControlLogic_Evaluate`, treat a reading older than about 500 ms as dead. **Motor off.**
- The XBee and the Pi already work this way. Copy them.

**Test:** `test_encoder_failure_stops_the_sail_motor`

---

## 2. You can't centre the rudder while the autopilot is on

🔴 **Safety.**

**What happens:** you push the joystick to rudder 0°. The firmware ignores you and keeps the autopilot's rudder.

**Why you care:** "centre the rudder" is the one thing you reach for when something looks wrong.

**Why it happens:** in `User/Src/control_logic.c` (`pick_source`), an XBee value of **exactly 0 means "no command"**. So while the Pi is talking, the Pi wins every time you send 0.

```c
if (xbee_valid && (!rpi_valid || xbee_value != 0.0f))
```

**Fix idea:** this one is a **team decision**, not just code:
- **Option A:** while the joystick is talking, it always wins, 0 included. You'd need a separate "hands off" signal to give control back.
- **Option B:** add an explicit "I'm steering" flag to the XBee packet, so 0 is never ambiguous.

**Test:** `test_operator_can_centre_the_rudder_while_the_autopilot_runs`

---

## 3. Full left rudder sends a pulse the servo can't take

🟠 **Breaks a feature.**

**What happens:** −45° plus the −130 µs trim gives **970 µs**. The servo's range is 1000–2000 µs.

**Why you care:** servos driven past their range buzz, run hot, or strip their gears.

**Why it happens:** `BoatControlTask` writes the pulse straight to the timer, and nothing clamps it.

**Fix:** ✅ done on branch `fix/rudder-pulse-limits`. It names the limits (`RUDDER_PWM_MIN_US`, `RUDDER_PWM_MAX_US`, centre 1370 µs) and clamps to them.

**Test:** `test_full_rudder_lock_stays_within_the_servo_range`

---

## 4. The sail can hunt back and forth

🟡 **Annoying, or might not matter.**

**What happens:** the sail motor is bang-bang: full speed, or off. If the mast turns faster than about **90°/s**, it overshoots the 4° dead band, reverses, overshoots again, and keeps going.

**Why you care:** motor wear, battery drain, and a wing that never settles.

**Why it *might* not matter:** this depends on how fast the real motor turns, and **nobody has measured that yet**. The simulator's number is a guess.

**Do this first:** time the mast at `MOTOR_SLOW` on the bench. Put the speed in `sim/params/windbound.toml` → `sail_drive.speed_dps_at_slow`.

**Fix idea (only if it's fast):** slow the motor down near the target, or add a little hysteresis to the dead band.

**Test:** `test_sail_step_settles_with_a_fast_motor`

---

## 5. Positions from the Pi are rounded to ~11 m

🟠 **Breaks a feature.**

**What happens:** the Pi sends `44.692512`, and the firmware keeps `44.6925`.

**Why you care:** 11 m is about 5 boat lengths. Waypoints and the boat's own position both get blurred.

**Why it happens:** `StringToFloat` (`User/Src/app_protocol.c`) only keeps **4 decimal places**, and it doesn't understand `1e-05` either.

**Fix:** ✅ done on branch `fix/rpi-link`. It keeps full precision and reads exponents. That branch also makes the RPi buffer bigger and adds wind speed and a "wind is valid" flag to what the STM32 sends the Pi.

**Test:** `test_rpi_positions_keep_metre_precision`

---

## 6. The Pi only has to talk every 5 s, which is too slow to steer

🟠 **Breaks a feature.**

**What happens:** the firmware waits **10 s** before deciding the Pi is gone (`RPI_TIMEOUT_MS`, commented "2x the send rate"). That suggests the Pi sends every 5 s. Steering with 5-second-old rudder commands makes the heading swing **about 55° either way**.

**Why you care:** the boat zig-zags, and every swing costs speed.

**Fix idea:**
- **Pi side:** send at least twice a second. ✅ DAL_MAST's `fix/pcb-link` branch now sends every 0.5 s.
- **STM32 side:** once the Pi is fast, drop the timeout to about 2 s, so a dead Pi gets noticed sooner.
- **Bigger option:** move the heading loop onto the STM32 itself, so the Pi only sends "steer 135°".

**Test:** `test_beam_reach_holds_course_at_the_configured_autopilot_rate`

---

## 7. The ground station sees the boat's position to the nearest degree

🟠 **Breaks a feature.**

**What happens:** telemetry says the boat is at `44, -63`. One degree is about **111 km**.

**Why you care:** the map on the ground station is useless, and so is any logged track.

**Why it happens:** `AppProtocol_FormatTelemetry` (`User/Src/app_protocol.c`) prints every field with `%d` and `(int)`, latitude and longitude included.

**Fix idea:**
- Send latitude and longitude as **micro-degrees**: `(int32_t)(lat * 1e6)` → `44692512`. The ground station divides by 1,000,000.
- Or print them with `%.6f`. Careful: newlib-nano's `printf` drops floats unless you link with `-u _printf_float`.
- The ground station's parser needs the same change.

**Test:** `test_telemetry_reports_a_usable_position`

---

## 8. Telemetry isn't valid JSON

🟡 **Annoying, or might not matter.**

**What happens:** every telemetry line ends `"sa":123,}`. That last comma isn't allowed in JSON.

**Why you care:** any strict JSON parser (Python's `json.loads`, for one) throws the whole line away. The joystick GUI copes, but only because its `parsing.py` uses a forgiving regex to work around exactly this. Every new tool would have to do the same.

**Fix:** one character. In `AppProtocol_FormatTelemetry`, change `"\"sa\":%d,"` to `"\"sa\":%d"`.

**Test:** `test_telemetry_is_valid_json`

---

## Where these came from

The simulator in `sim/` compiles the **real** firmware from `User/` and runs it against a model of the boat, the wind and Lake Micmac. These are logic bugs, so they'd happen on the real boat too. The physics numbers (motor speed, rudder size) are estimates, which is why #4 says "measure first".

Found a new one? Write a test for it in `sim/tests/`, mark it `@pytest.mark.xfail(strict=True, reason="...")` with a plain-English reason, and add a row to the table above.
