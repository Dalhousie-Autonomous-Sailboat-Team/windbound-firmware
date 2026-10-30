# Windbound Firmware

This is the firmware repository for Windbound - An autonomous sailboat created by Dalhousie's Microtransat Autonomous Sailboat Team (DalMAST).

This revision is based around the STM32H573 microcontroller, and runs FreeRTOS. This project is intended to be developed outside of the STM32CubeIDE environment. Instead, STM32CubeMX is used for pin configuration and peripheral initialization, and binaries are generated using the CMake build system and the clang compiler. VSCode with the STM32 and Cortex-Debug extensions is recommended for development.

Development follows a layered architecture, with hardware-level code in L1, data-level code in L2, abstraction-level code in L3, and application-level code in L4. See the Project Structure section below for more details. Code is written in C using CMSIS OS2 for RTOS functionality and STM32 HAL for hardware drivers.

## Try it without the boat

```bash
python3 sim/start.py
```

opens the simulator and ground station in your browser: this firmware sailing a simulated Windbound on Lake Micmac, the joystick's GUI, and a button that rebuilds the firmware and runs every test against it. See [sim/README.md](sim/README.md) for what to install first and a five-minute tour.

**Known bugs:** [KNOWN_ISSUES.md](KNOWN_ISSUES.md) lists the 8 things the firmware gets wrong today, worst first, with a fix idea and a test for each.

## Project Structure

- `cmake/`: CubeMX generated CMake files
- `Core/`: CubeMX generated source files - **main.c is in this directory**
- `Docs/`: Board Schematic, datasheets, and development journal
- `Drivers/`: External drivers and libraries
- `Middlewares/`: RTOS and other middleware libraries
- `Templates/`: Template files for user source and header files
- **`User/`**: User created source files
  - `usermain.c`: User main file - **Entry point for user code**
  - `L1/`: Hardware-level source files
  - `L2/`: Data level source files
  - `L3/`: Abstraction-level source files
  - `L4/`: Application-level source files
  - `Utils/`: Utility source files
- `build/`: Temporary Build directory
- `CMakeLists.txt`: Main CMake file - **Add new source files here**

## macOS setup

The project uses ST's Arm Clang toolchain and the STM32Cube VS Code bundle
manager. After installing the repository prerequisites, activate the embedded
tools in a terminal with:

```sh
. tools/stm32-env.sh
cmake --preset Debug
cmake --build --preset Debug
```

The resulting firmware image is `build/Debug/Nautono_V3.elf`. The repository's
VS Code launch configuration uses the ST-LINK GDB server and can be started
from the Run and Debug panel after an ST-LINK probe is connected to the target.
