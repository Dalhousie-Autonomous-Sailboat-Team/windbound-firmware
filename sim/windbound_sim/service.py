"""The Windbound service: one local web server for the ground station and the
simulator.

    python -m windbound_sim serve        ->  http://127.0.0.1:8765

It runs the simulator (runner.py), the ground station's view of the boat
(groundstation.py) and the firmware checks (proof.py), and serves the page in
web/. The page talks to it over:

    GET  /api/stream      Server-Sent Events: "hello", then "sim", "ground"
                          and "proof" whenever they change
    GET  /api/scene       the running scenario: boat dimensions, course, lake
    GET  /api/map         the lake's depth grid for the 2D map
    GET  /api/scenarios   GET /api/ports     GET /boat.glb
    POST /api/sim         {"action": ...}  run, speed, wind, faults, joystick, route
    POST /api/ground      {"action": "connect", "url": ..., "baud": ...} or "simulator"
    POST /api/firmware    {"action": "rebuild" | "check" | "watch", ...}

It listens on 127.0.0.1 only, answers only requests addressed to it by that
name (so a site that rebinds its own name to 127.0.0.1 can't read it), and
takes commands only as JSON from its own page, so another website can't
rebuild the firmware or move the boat.
"""

import json
import math
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .autopilot import AutopilotStandIn
from .groundstation import GroundStation, serial_ports
from .link import GroundStationLink
from .proof import Proof
from .runner import SimRunner
from .scenarios import SCENARIOS
from .sim import find_lake
from .world import Lake

WEB_DIR = Path(__file__).resolve().parent / "web"
DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "boat.glb"
DEFAULT_PORT = 8765
MAP_LAKE = "Lake_Micmac"
STREAM_HZ = 30
SCENE_CELL_M = 12.0
MAP_CELL_M = 4.0
MAX_BODY = 64 * 1024
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}


def boat_geometry(params):
    """Dimensions for the default 3D boat, from the physics parameters.

    Beam, freeboard and hull depth are not boat parameters yet, so they come
    from the waterline length in typical proportions for a small keelboat.
    """
    def foil(f):
        span = math.sqrt(f.area_m2 * f.aspect_ratio)
        return {"span_m": span, "chord_m": f.area_m2 / span, "x_m": f.x_m, "z_m": f.z_m}

    lwl = params.hull.lwl_m
    return {
        "hull": {"length_m": lwl * 1.06, "beam_m": lwl * 0.24,
                 "freeboard_m": lwl * 0.1, "depth_m": lwl * 0.09},
        "wing": foil(params.wing),
        "keel": foil(params.keel),
        "rudder": foil(params.rudder),
    }


def depth_grid(lake, cell_m, to_xy):
    """The lake's depth grid thinned to about ``cell_m``, its corners placed by
    ``to_xy(lat, lon)``. Land is null."""
    rows, cols = lake.depth.shape
    top, left = to_xy(lake.north, lake.west)
    bottom, right = to_xy(lake.south, lake.east)
    lat_m = (lake.north - lake.south) * 111_195.0 / (rows - 1)
    step = max(1, round(cell_m / lat_m))
    thinned = lake.depth[::step, ::step]
    return {
        "name": lake.name, "top": top, "bottom": bottom, "left": left, "right": right,
        "rows": int(thinned.shape[0]), "cols": int(thinned.shape[1]),
        "depth": [None if math.isnan(v) else round(float(v), 1) for v in thinned.ravel()],
    }


def scene_for(sim, model_path):
    """What the 3D view needs about the running scenario, in north/east metres."""
    sc = sim.scenario
    waypoints = []
    if sim.autopilot:
        for lat, lon in sim.autopilot.plan.waypoints:
            north, east = sim.origin.to_local(lat, lon)
            waypoints.append({"north": north, "east": east})
    lake = None
    if sim.lake:
        lake = depth_grid(sim.lake, SCENE_CELL_M, sim.origin.to_local)
    return {
        "scenario": {"name": sc.name, "title": sc.title, "description": sc.description,
                     "duration_s": sc.duration_s},
        "origin": {"lat": sim.origin.lat, "lon": sim.origin.lon},
        "boat": boat_geometry(sim.params),
        "draft_m": sim.params.hull.draft_m,
        "model": "/boat.glb" if model_path else None,
        "waypoints": waypoints,
        "lake": lake,
    }


class WindboundService:
    def __init__(self, params, scenario="micmac-course", speed=5, host="127.0.0.1", port=DEFAULT_PORT,
                 link_port=None, model_path=None, autopilot=AutopilotStandIn):
        if model_path is None and DEFAULT_MODEL_PATH.is_file():
            model_path = DEFAULT_MODEL_PATH
        self.model_path = Path(model_path) if model_path else None
        self.ground = GroundStation()
        self.tcp_link = GroundStationLink(port=link_port) if link_port is not None else None
        self.runner = SimRunner(params, scenario, speed, ground=self.ground, link=self.tcp_link,
                                 autopilot=autopilot)
        self.proof = Proof(on_reloaded=self.runner.restart)
        lake_path = find_lake(MAP_LAKE)
        self.map_lake = Lake(lake_path) if lake_path else None
        self._map_json = None
        self._scene_cache = (None, None)

        service = self

        class Handler(_Handler):
            owner = service

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.server.daemon_threads = True
        self.host, self.port = self.server.server_address[:2]

    @property
    def url(self):
        return f"http://{self.host}:{self.port}/"

    @property
    def own_hosts(self):
        return {f"{self.host}:{self.port}", f"localhost:{self.port}"}

    def serve_forever(self):
        self.server.serve_forever()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        if self.tcp_link:
            self.tcp_link.close()

    # ----- data for the page ------------------------------------------------ #

    def scene_json(self):
        run, cached = self._scene_cache
        if run != self.runner.run_id or cached is None:
            sim = self.runner.sim
            cached = json.dumps(scene_for(sim, self.model_path)).encode()
            self._scene_cache = (self.runner.run_id, cached)
        return cached

    def map_json(self):
        if self._map_json is None:
            lake = self.map_lake
            body = {"lake": None}
            if lake:
                grid = depth_grid(lake, MAP_CELL_M, lambda lat, lon: (lat, lon))
                body["lake"] = {**grid, "north": lake.north, "south": lake.south,
                                "west": lake.west, "east": lake.east}
            self._map_json = json.dumps(body).encode()
        return self._map_json

    def scenarios(self):
        return [{"name": s.name, "title": s.title, "description": s.description, "duration_s": s.duration_s}
                for s in SCENARIOS.values()]

    # ----- commands from the page ------------------------------------------- #

    def command(self, area, body):
        action = body.pop("action", None)
        if area == "sim":
            self.runner.submit(action, **body)
        elif area == "ground":
            if action == "connect":
                self.ground.connect_serial(str(body["url"]), int(body.get("baud", 115200)))
            elif action == "simulator":
                self.ground.use_simulator()
            else:
                raise ValueError(f"unknown ground action {action!r}")
        elif area == "firmware":
            if action == "rebuild":
                self.proof.rebuild()
            elif action == "check":
                self.proof.run_checks()
            elif action == "watch":
                self.proof.set_watch(bool(body.get("on")))
            else:
                raise ValueError(f"unknown firmware action {action!r}")
        else:
            raise ValueError(f"unknown area {area!r}")


class _Handler(BaseHTTPRequestHandler):
    owner: WindboundService

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        service = self.owner
        if self.headers.get("Host") not in service.own_hosts:
            self._send(421, "text/plain", b"Open the Windbound page at its own address.")
        elif path == "/api/stream":
            self._stream()
        elif path == "/api/scene":
            self._send(200, "application/json", service.scene_json())
        elif path == "/api/map":
            self._send(200, "application/json", service.map_json(), cache=True)
        elif path == "/api/scenarios":
            self._json(service.scenarios())
        elif path == "/api/ports":
            self._json(serial_ports())
        elif path == "/boat.glb":
            model = service.model_path
            if model and model.is_file():
                self._send(200, "model/gltf-binary", model.read_bytes())
            else:
                self._send(404, "text/plain", b"No boat model; the page draws the default boat.")
        else:
            # Only files directly in web/ are served.
            name = "index.html" if path == "/" else path.lstrip("/")
            file = WEB_DIR / name
            if "/" not in name and file.suffix in CONTENT_TYPES and file.is_file():
                self._send(200, CONTENT_TYPES[file.suffix], file.read_bytes())
            else:
                self._send(404, "text/plain", b"Not found")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if self.headers.get("Host") not in self.owner.own_hosts:
            self._send(421, "text/plain", b"Open the Windbound page at its own address.")
            return
        if not path.startswith("/api/") or not self._from_own_page():
            self._send(403, "text/plain", b"Commands are accepted from the Windbound page only.")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._send(413, "text/plain", b"Too large")
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("expected a JSON object")
            self.owner.command(path.removeprefix("/api/"), body)
        except (ValueError, KeyError, TypeError) as exc:
            self._json({"error": str(exc)}, status=400)
            return
        except OSError as exc:          # a serial port that won't open
            self._json({"error": str(exc)}, status=409)
            return
        self._send(204, "text/plain", b"")

    def _from_own_page(self):
        """JSON only (a cross-site form can't send it without a CORS preflight,
        which this server never approves), and from this server's own origin."""
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{host}" for host in self.owner.own_hosts}

    def _json(self, data, status=200):
        self._send(status, "application/json", json.dumps(data).encode())

    def _send(self, status, content_type, body, cache=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _event(self, name, data):
        payload = data if isinstance(data, str) else json.dumps(data, separators=(",", ":"))
        self.wfile.write(f"event: {name}\ndata: {payload}\n\n".encode())

    def _stream(self):
        service = self.owner
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        sim_seen = ground_seen = proof_seen = -1
        line_seq = 0
        last_write = time.monotonic()
        try:
            self._event("hello", {**service.runner.history(), "link_port":
                                  service.tcp_link.port if service.tcp_link else None})
            while True:
                wrote = False
                version, snapshot = service.runner.snapshot()
                if snapshot is not None and version != sim_seen:
                    self._event("sim", snapshot)
                    sim_seen, wrote = version, True
                if service.ground.version != ground_seen:
                    ground_seen = service.ground.version
                    ground = service.ground.snapshot(since_seq=line_seq)
                    line_seq = ground["seq"]
                    self._event("ground", ground)
                    wrote = True
                if service.proof.version != proof_seen:
                    proof_seen = service.proof.version
                    self._event("proof", service.proof.snapshot())
                    wrote = True
                now = time.monotonic()
                if wrote:
                    last_write = now
                elif now - last_write > 2.0:
                    self.wfile.write(b": still here\n\n")      # keeps the connection open
                    last_write = now
                self.wfile.flush()
                time.sleep(1.0 / STREAM_HZ)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format, *args):
        pass
