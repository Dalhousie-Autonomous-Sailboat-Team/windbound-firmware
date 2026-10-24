"""Command line.

    python -m windbound_sim serve                 the web app: ground station + simulator
    python -m windbound_sim list                  the scenarios
    python -m windbound_sim run beam-reach        one scenario, headless, with a summary
    python -m windbound_sim run micmac-course --link --speed 5
    python -m windbound_sim run sail-step --set sail_drive.speed_dps_at_slow=120
"""

import argparse
import sys
import webbrowser

from .autopilot import AutopilotStandIn
from .link import DEFAULT_PORT as LINK_PORT
from .link import GroundStationLink
from .params import DEFAULT_PARAMS_PATH, load_params
from .scenarios import SCENARIOS
from .service import DEFAULT_PORT as SERVICE_PORT
from .service import WindboundService
from .sim import Simulation


def parse_settings(settings):
    """Turn ["table.key=value", ...] into {"table": {"key": value}}."""
    tables = {}
    for item in settings:
        name, _, value = item.partition("=")
        table, _, key = name.partition(".")
        if not (table and key and value):
            raise SystemExit(f"--set expects table.key=value, got {item!r}")
        tables.setdefault(table, {})[key] = float(value) if "." in value else int(value)
    return tables


DALMAST_PERIOD_MS = 500        # PCBComm's write_period_s on fix/pcb-link


def load(args):
    params = load_params(args.params)
    if getattr(args, "autopilot", None) == "dalmast":
        params = params.with_changes(autopilot={"period_ms": DALMAST_PERIOD_MS})
    return params.with_changes(**parse_settings(args.set)) if args.set else params


def autopilot(args):
    if args.autopilot == "standin":
        return AutopilotStandIn
    from .dalmast import factory
    try:
        return factory()
    except FileNotFoundError as error:
        sys.exit(f"{error}")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m windbound_sim",
                                     description="Windbound firmware-in-the-loop simulator.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="list the scenarios")

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--params", default=DEFAULT_PARAMS_PATH, help="boat parameter file")
    common.add_argument("--set", action="append", default=[], metavar="TABLE.KEY=VALUE",
                        help="override one parameter, e.g. autopilot.period_ms=1000")
    common.add_argument("--autopilot", choices=["standin", "dalmast"], default="standin",
                        help="the Raspberry Pi's side: the simple stand-in, or DAL_MAST's own "
                             "navigation (found at $WINDBOUND_DALMAST_DIR or ../DAL_MAST)")

    serve = sub.add_parser("serve", parents=[common], help="run the web app")
    serve.add_argument("--scenario", choices=sorted(SCENARIOS), default="micmac-course")
    serve.add_argument("--speed", default="5", choices=["1", "5", "20", "max"])
    serve.add_argument("--port", type=int, default=SERVICE_PORT)
    serve.add_argument("--link-port", type=int, default=LINK_PORT,
                       help="TCP port for the desktop ground station (0 turns it off)")
    serve.add_argument("--model", help="a boat.glb to show instead of the default boat "
                                       "(default: sim/models/boat.glb when it exists)")
    serve.add_argument("--no-open", action="store_true", help="don't open the browser")

    run = sub.add_parser("run", parents=[common], help="run one scenario")
    run.add_argument("scenario", choices=sorted(SCENARIOS))
    run.add_argument("--link", action="store_true",
                     help="serve the ground-station link and run in real time")
    run.add_argument("--port", type=int, default=LINK_PORT)
    run.add_argument("--speed", type=float, default=1.0, help="real-time multiplier with --link")
    run.add_argument("--duration", type=float, help="seconds of simulated time")
    args = parser.parse_args(argv)

    if args.command == "list":
        for name, scenario in SCENARIOS.items():
            print(f"{name:26} {scenario.description}")
        return 0

    if args.command == "serve":
        speed = args.speed if args.speed == "max" else int(args.speed)
        service = WindboundService(load(args), args.scenario, speed, port=args.port,
                                   link_port=args.link_port or None, model_path=args.model,
                                   autopilot=autopilot(args))
        print(f"\n  Windbound is running at {service.url}")
        if service.tcp_link:
            print(f"  Desktop ground station: connect it to {service.tcp_link.url}")
        print("  Press Ctrl+C to stop.\n", flush=True)
        if not args.no_open:
            webbrowser.open(service.url)
        try:
            service.serve_forever()
        except KeyboardInterrupt:
            print("\n  Stopped.")
        finally:
            service.close()
        return 0

    scenario = SCENARIOS[args.scenario]
    link = None
    if args.link:
        link = GroundStationLink(port=args.port)
        print(f"Ground station: connect to {link.url}")
    sim = Simulation(scenario, load(args), link=link, autopilot=autopilot(args))
    if scenario.lake and sim.lake is None:
        print(f"Note: no depth grid found for {scenario.lake}; depth checks are off. "
              "Set WINDBOUND_LAKE_DIR to the ground station's lake_depth_maps folder.")
    try:
        sim.run(args.duration, realtime=bool(link), speed=args.speed)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        if link:
            link.close()
    for key, value in sim.summary().items():
        print(f"{key:28} {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
