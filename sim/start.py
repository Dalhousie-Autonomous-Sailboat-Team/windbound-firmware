#!/usr/bin/env python3
"""Start Windbound: the simulator and the ground station in your browser.

    python3 sim/start.py              (Windows: py sim\\start.py)

The first run sets up a Python environment in sim/.venv and builds the
firmware library, which takes a minute or two; later runs start in seconds
and only rebuild what changed. Anything you add goes to the service, e.g.
`python3 sim/start.py --scenario beam-reach --speed 1`. See sim/README.md.

This file uses only the standard library, so it runs on any Python 3.11+.
"""

import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.request
import webbrowser
from pathlib import Path

SIM = Path(__file__).resolve().parent
REPO = SIM.parent
VENV = SIM / ".venv"
REQUIREMENTS = SIM / "requirements.txt"
STAMP = VENV / ".windbound-requirements"
PORT, LINK_PORT = 8765, 5760
GUI_REPO = "https://github.com/Dalhousie-Autonomous-Sailboat-Team/simpleSailboatGUI.git"


def say(text=""):
    print(f"  {text}" if text else "", flush=True)


def fail(title, *lines):
    print(f"\n  ✗ {title}", file=sys.stderr)
    for line in lines:
        print(f"    {line}", file=sys.stderr)
    print(file=sys.stderr)
    sys.exit(1)


def venv_python():
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def in_venv():
    return Path(sys.prefix).resolve() == VENV.resolve()


# ----- step 1, on the system Python: the environment ------------------------- #

def ensure_environment():
    if sys.version_info < (3, 11):
        fail("Windbound needs Python 3.11 or newer.",
             f"This is Python {sys.version.split()[0]}. Get a newer one at https://www.python.org/downloads/",
             "then run this again.")
    python = venv_python()
    if not python.exists():
        say("Setting up a Python environment in sim/.venv (first run only)…")
        if subprocess.run([sys.executable, "-m", "venv", str(VENV)]).returncode:
            fail("Couldn't create the Python environment in sim/.venv.",
                 "On Debian or Ubuntu: sudo apt install python3-venv")
    wanted = hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()
    if not STAMP.exists() or STAMP.read_text().strip() != wanted:
        say("Installing the Python packages it needs (numpy, pyserial, pytest)…")
        result = subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "-q",
                                 "-r", str(REQUIREMENTS)])
        if result.returncode:
            fail("Couldn't install the Python packages.", "Check your internet connection and run this again.")
        STAMP.write_text(wanted)
    return python


# ----- step 2, inside the environment: firmware, maps, port, go ------------- #

def ensure_cmake():
    if shutil.which("cmake"):
        return
    hints = {
        "darwin": ["Install the compiler and CMake, then run this again:",
                   "  xcode-select --install",
                   "  brew install cmake        (or https://cmake.org/download/)"],
        "win32": ["Install CMake from https://cmake.org/download/ (tick \"Add CMake to the PATH\"),",
                  "and Visual Studio Build Tools with \"Desktop development with C++\",",
                  "then open a new terminal and run this again."],
    }.get(sys.platform, ["Install CMake and a C compiler, then run this again:",
                         "  sudo apt install cmake build-essential"])
    fail("Windbound builds the firmware with CMake, which isn't installed.", *hints)


def build_firmware():
    from windbound_sim.firmware import build_library

    say("Building the firmware library from User/ (the first build takes a minute)…")
    ok, output = build_library()
    if not ok:
        print(output[-6000:])
        fail("The firmware didn't build.", "The compiler's messages are above. Fix the error, then run this again.")


def check_lakes():
    from windbound_sim.sim import find_lake

    if find_lake("Lake_Micmac"):
        return
    say("No lake depth maps found, so the lake scenarios will sail on open water.")
    say("To get them, put the desktop ground station next to this repo:")
    say(f"  git clone {GUI_REPO} \"{REPO.parent / 'simpleSailboatGUI'}\"")
    say("or set WINDBOUND_LAKE_DIR to its lake_depth_maps folder.")
    say()


def windbound_at(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/scenarios", timeout=1) as response:
            return isinstance(json.load(response), list)
    except (OSError, ValueError):
        return False


def free(port):
    """Nothing is listening there. (A trial bind would also refuse a port
    whose last connections are still closing, which the servers reuse.)"""
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) != 0


def first_free(start):
    return next(port for port in range(start, start + 50) if free(port))


def serve(args):
    if "--port" not in args:
        if windbound_at(PORT):
            url = f"http://127.0.0.1:{PORT}/"
            say(f"Windbound is already running at {url} — opening it.")
            webbrowser.open(url)
            return 0
        args = [*args, "--port", str(first_free(PORT))]
    if "--link-port" not in args and not free(LINK_PORT):
        args = [*args, "--link-port", str(first_free(LINK_PORT + 1))]
    from windbound_sim.__main__ import main

    return main(["serve", *args])


def main():
    args = sys.argv[1:]
    if not in_venv():
        print("\n  Windbound\n", flush=True)
        python = ensure_environment()
        command = [str(python), str(Path(__file__).resolve()), *args]
        if os.name == "nt":
            sys.exit(subprocess.call(command))
        os.execv(command[0], command)          # the same terminal, now inside the environment
    sys.path.insert(0, str(SIM))
    ensure_cmake()
    build_firmware()
    check_lakes()
    return serve(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  Stopped.")
