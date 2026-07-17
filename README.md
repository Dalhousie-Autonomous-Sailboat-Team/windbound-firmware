# Windbound Firmware

This is the firmware repository for Windbound - An autonomous sailboat created by Dalhousie's Microtransat Autonomous Sailboat Team (DalMAST).

This revision is based around the STM32H573 microcontroller, and runs FreeRTOS. This project is intended to be developed outside of the STM32CubeIDE environment. Instead, STM32CubeMX is used for pin configuration and peripheral initialization, and binaries are generated using the CMake build system and the clang compiler. VSCode with the STM32 and Cortex-Debug extensions is recommended for development.

Development follows a layered architecture, with hardware-level code in L1, data-level code in L2, abstraction-level code in L3, and application-level code in L4. See the Project Structure section below for more details. Code is written in C using CMSIS OS2 for RTOS functionality and STM32 HAL for hardware drivers.

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
