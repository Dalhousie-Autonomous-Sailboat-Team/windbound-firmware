/*
 * The Helm's lake map: the depth grid, the route coloured by the depth along
 * each leg, the boat and its track. Click to add a waypoint, drag one to move
 * it, drag the water to pan, scroll to zoom.
 *
 * Depth classes follow waypoints.py in the desktop ground station: 2.5 m or
 * deeper is clear, 2.0 to 2.5 m is caution, under the 2.0 m draft is shallow.
 * Land inside the grid counts as shallow; outside the grid is unknown.
 */
const R = 6371000, K = Math.PI / 180;
const SAFE_M = 2.5;
const SAMPLE_M = 2;
const HIT_PX = 14;

/* Water shaded in the lake-inventory blue the ground station's contours use;
   water under the draft in the pale amber of its shallow legs. */
const PALETTE = {
  light: { shallow: [228, 238, 246], deep: [118, 160, 194], plain: [225, 235, 243], shoal: [247, 233, 202] },
  dark: { shallow: [22, 35, 47], deep: [30, 79, 117], plain: [21, 33, 45], shoal: [52, 41, 22] },
};

/* Line segments (as col, row pairs) where the depth crosses `level` metres:
   marching squares over the grid, land counting as -1 m, so level 0 traces
   the shore. Drawn as crisp lines over the smoothed depth image. */
function contour(lake, level) {
  const { rows, cols, depth } = lake;
  const v = (r, c) => { const d = depth[r * cols + c]; return d === null ? -1 : d; };
  const out = [];
  const at = (p, q) => (level - p) / (q - p);
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const tl = v(r, c), tr = v(r, c + 1), br = v(r + 1, c + 1), bl = v(r + 1, c);
      const k = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (k === 0 || k === 15) continue;
      const top = [c + at(tl, tr), r], right = [c + 1, r + at(tr, br)];
      const bottom = [c + at(bl, br), r + 1], left = [c, r + at(tl, bl)];
      const pairs = { 1: [left, bottom], 14: [left, bottom], 2: [bottom, right], 13: [bottom, right],
                      3: [left, right], 12: [left, right], 4: [top, right], 11: [top, right],
                      6: [top, bottom], 9: [top, bottom], 7: [left, top], 8: [left, top],
                      5: [left, top, bottom, right], 10: [top, right, left, bottom] }[k];
      for (const point of pairs) out.push(point[0], point[1]);
    }
  }
  return new Float32Array(out);
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class LakeMap {
  constructor(container, canvas, { onAdd, onMove }) {
    this.container = container;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onAdd = onAdd;
    this.onMove = onMove;
    this.lake = null;
    this.base = "depth";
    this.theme = "light";
    this.route = [];
    this.active = -1;
    this.reached = 0;
    this.track = [];
    this.boat = null;
    this.draft = 2.0;
    this.view = null;
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindPointer();
  }

  /* ----- data ------------------------------------------------------------- */

  setLake(lake, draft) {
    this.lake = lake;
    this.draft = draft;
    this.shore = contour(lake, 0);
    this.draftLine = contour(lake, draft);
    this.lat0 = (lake.north + lake.south) / 2;
    this.lon0 = (lake.west + lake.east) / 2;
    this.cos0 = Math.cos(this.lat0 * K);
    this.view = null;
    this.paintDepth();
    this.resize();
  }
  setTheme(name) { this.theme = name; this.chartKey = null; this.paintDepth(); this.draw(); }
  setBase(base) { this.base = base; this.paintDepth(); this.draw(); }
  setRoute(route, active, reached) { this.route = route; this.active = active; this.reached = reached; this.draw(); }
  setTrack(track) { this.track = track; this.draw(); }
  setBoat(boat) { this.boat = boat; this.draw(); }

  /* Depth in metres at a point: null on land inside the grid, undefined outside it. */
  depthAt(lat, lon) {
    const l = this.lake;
    if (!l || lat > l.north || lat < l.south || lon < l.west || lon > l.east) return undefined;
    const r = Math.round(((l.north - lat) / (l.north - l.south)) * (l.rows - 1));
    const c = Math.round(((lon - l.west) / (l.east - l.west)) * (l.cols - 1));
    return l.depth[r * l.cols + c];
  }

  /* The class of each 2 m step along a leg, and the shallowest depth on it. */
  legProfile(a, b) {
    const length = this.distance(a, b);
    const steps = Math.max(1, Math.ceil(length / SAMPLE_M));
    const classes = [];
    let shallowest = Infinity, unknown = false;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const d = this.depthAt(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
      if (d === undefined) { classes.push("unknown"); unknown = true; continue; }
      const depth = d === null ? 0 : d;
      shallowest = Math.min(shallowest, depth);
      classes.push(depth >= SAFE_M ? "clear" : depth >= this.draft ? "caution" : "shallow");
    }
    const shallowMetres = classes.filter((c) => c === "shallow").length * (length / (steps + 1));
    return { length, classes, shallowest: shallowest === Infinity ? null : shallowest, unknown, shallowMetres };
  }

  distance(a, b) {
    return Math.hypot((b.lon - a.lon) * K * R * Math.cos(((a.lat + b.lat) / 2) * K), (b.lat - a.lat) * K * R);
  }

  /* ----- projection --------------------------------------------------------- */

  toMetres(lat, lon) { return [(lon - this.lon0) * K * R * this.cos0, (lat - this.lat0) * K * R]; }
  toLatLon(x, y) { return { lat: this.lat0 + y / (K * R), lon: this.lon0 + x / (K * R * this.cos0) }; }
  toScreen(lat, lon) {
    const [x, y] = this.toMetres(lat, lon), v = this.view;
    return [this.w / 2 + (x - v.cx) * v.scale, this.h / 2 - (y - v.cy) * v.scale];
  }
  fromScreen(px, py) {
    const v = this.view;
    return this.toLatLon(v.cx + (px - this.w / 2) / v.scale, v.cy - (py - this.h / 2) / v.scale);
  }

  fit() {
    const l = this.lake;
    const [x0, y0] = this.toMetres(l.south, l.west), [x1, y1] = this.toMetres(l.north, l.east);
    const scale = Math.min(this.w / (x1 - x0), this.h / (y1 - y0)) * 0.94;
    this.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale };
  }

  zoomBy(factor, px = this.w / 2, py = this.h / 2) {
    if (!this.view) return;
    const before = this.fromScreen(px, py);
    this.view.scale = Math.min(Math.max(this.view.scale * factor, 0.05), 40);
    const after = this.fromScreen(px, py);
    const [bx, by] = this.toMetres(before.lat, before.lon), [ax, ay] = this.toMetres(after.lat, after.lon);
    this.view.cx += bx - ax;
    this.view.cy += by - ay;
    this.draw();
  }

  centreOnBoat() {
    if (!this.view || !this.boat) return;
    [this.view.cx, this.view.cy] = this.toMetres(this.boat.lat, this.boat.lon);
    this.draw();
  }

  /* ----- drawing ------------------------------------------------------------ */

  paintDepth() {
    const l = this.lake;
    if (!l) return;
    const image = document.createElement("canvas");
    image.width = l.cols; image.height = l.rows;
    const ctx = image.getContext("2d");
    const data = ctx.createImageData(l.cols, l.rows);
    const p = PALETTE[this.theme];
    for (let i = 0; i < l.depth.length; i++) {
      const d = l.depth[i];
      if (d === null) continue;                           // land: the map's background shows
      const t = this.base === "plain" ? null : Math.pow(Math.min(d / 6.5, 1), 0.75);
      const rgb = t === null ? p.plain : d < this.draft ? p.shoal : p.shallow.map((s, k) => s + (p.deep[k] - s) * t);
      data.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
    }
    ctx.putImageData(data, 0, 0);
    this.depthImage = image;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = rect.width; this.h = rect.height; this.dpr = dpr;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.lake && !this.view) this.fit();
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    if (!this.w) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.lake || !this.view) return;
    ctx.drawImage(this.chart(), 0, 0, this.w, this.h);
    this.drawTrack();
    this.drawRoute();
    this.drawBoat();
    this.drawScale();
  }

  /* The lake itself (depth shading, shoreline, draft line) changes only when
     the view, the size, the theme or the shading does, so it is drawn once
     into its own canvas and copied under the moving parts. */
  chart() {
    const v = this.view;
    const key = [this.w, this.h, this.dpr, v.cx, v.cy, v.scale, this.theme, this.base, this.depthImage?.width].join();
    if (this.chartKey === key) return this.chartCanvas;
    this.chartKey = key;
    const canvas = this.chartCanvas ??= document.createElement("canvas");
    canvas.width = Math.round(this.w * this.dpr);
    canvas.height = Math.round(this.h * this.dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const l = this.lake;
    const [ax, ay] = this.toScreen(l.north, l.west), [bx, by] = this.toScreen(l.south, l.east);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.depthImage, ax, ay, bx - ax, by - ay);
    if (this.base !== "plain") this.drawLines(ctx, this.draftLine, css("--shallow"), 1, 0.75, ax, ay, bx, by);
    this.drawLines(ctx, this.shore, css("--muted"), 1.25, 0.9, ax, ay, bx, by);
    return canvas;
  }

  /* Contour segments from grid units to the screen: the grid's corners map
     linearly onto the screen box (ax, ay)-(bx, by). */
  drawLines(ctx, segments, colour, width, alpha, ax, ay, bx, by) {
    const l = this.lake;
    const sx = (bx - ax) / (l.cols - 1), sy = (by - ay) / (l.rows - 1);
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < segments.length; i += 4) {
      ctx.moveTo(ax + segments[i] * sx, ay + segments[i + 1] * sy);
      ctx.lineTo(ax + segments[i + 2] * sx, ay + segments[i + 3] * sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawTrack() {
    if (this.track.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = css("--text");
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.setLineDash([0.5, 5]);
    ctx.beginPath();
    this.track.forEach((p, i) => { const [x, y] = this.toScreen(p.lat, p.lon); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.restore();
  }

  drawRoute() {
    const ctx = this.ctx, route = this.route;
    const colours = { clear: css("--deep"), caution: css("--shallow"), shallow: css("--under"), unknown: css("--unknown") };
    const dashes = { clear: [], caution: [8, 4], shallow: [1, 6], unknown: [3, 4] };
    if (this.boat && this.active >= 0 && this.active < route.length && this.reached < route.length) {
      const [x0, y0] = this.toScreen(this.boat.lat, this.boat.lon);
      const [x1, y1] = this.toScreen(route[this.active].lat, route[this.active].lon);
      ctx.save();
      ctx.strokeStyle = css("--text"); ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.restore();
    }
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      const profile = this.legProfile(a, b);
      const [x0, y0] = this.toScreen(a.lat, a.lon), [x1, y1] = this.toScreen(b.lat, b.lon);
      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = css("--surface"); ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      // Each run of the same class drawn in its own style.
      const n = profile.classes.length;
      let start = 0;
      for (let k = 1; k <= n; k++) {
        if (k < n && profile.classes[k] === profile.classes[start]) continue;
        const cls = profile.classes[start];
        const t0 = start / (n - 1 || 1), t1 = Math.min(k, n - 1) / (n - 1 || 1);
        ctx.strokeStyle = colours[cls];
        ctx.lineWidth = cls === "shallow" ? 5.5 : 5;
        ctx.setLineDash(dashes[cls]);
        ctx.beginPath();
        ctx.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
        ctx.lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
        ctx.stroke();
        start = k;
      }
      ctx.restore();
    }
    ctx.save();
    ctx.font = `600 12px ${css("--sans")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    route.forEach((p, i) => {
      const [x, y] = this.toScreen(p.lat, p.lon);
      const done = i < this.reached, active = i === this.active && !done;
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fillStyle = active ? css("--accent") : css("--surface");
      ctx.fill();
      ctx.lineWidth = active ? 2.5 : 2;
      ctx.strokeStyle = active ? css("--surface") : done ? css("--control") : css("--text");
      ctx.stroke();
      ctx.fillStyle = active ? css("--primary-ink") : done ? css("--faint") : css("--text");
      ctx.fillText(String(i + 1), x, y + 0.5);
    });
    ctx.restore();
  }

  drawBoat() {
    if (!this.boat) return;
    const ctx = this.ctx;
    const [x, y] = this.toScreen(this.boat.lat, this.boat.lon);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((this.boat.heading * Math.PI) / 180);
    ctx.scale(1.15, 1.15);
    ctx.beginPath();
    ctx.moveTo(0, -17); ctx.bezierCurveTo(6.5, -8, 7.5, 5, 5, 15); ctx.lineTo(-5, 15);
    ctx.bezierCurveTo(-7.5, 5, -6.5, -8, 0, -17); ctx.closePath();
    ctx.fillStyle = css("--text");
    ctx.strokeStyle = css("--surface");
    ctx.lineWidth = 1.6;
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawScale() {
    const ctx = this.ctx;
    const options = [10, 20, 50, 100, 200, 500, 1000];
    const metres = options.find((m) => m * this.view.scale >= 70) || 1000;
    const px = metres * this.view.scale;
    const x1 = this.w - 16, x0 = x1 - px, y = this.h - 18;
    ctx.save();
    ctx.strokeStyle = css("--text"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y - 5); ctx.lineTo(x0, y); ctx.lineTo(x1, y); ctx.lineTo(x1, y - 5); ctx.stroke();
    ctx.font = `500 12px ${css("--sans")}`;
    ctx.fillStyle = css("--text");
    ctx.textAlign = "right";
    ctx.lineWidth = 4; ctx.strokeStyle = css("--surface");
    const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
    ctx.strokeText(label, x1, y - 9); ctx.fillText(label, x1, y - 9);
    ctx.restore();
  }

  /* ----- pointer ------------------------------------------------------------ */

  hit(px, py) {
    for (let i = this.route.length - 1; i >= 0; i--) {
      const [x, y] = this.toScreen(this.route[i].lat, this.route[i].lon);
      if (Math.hypot(px - x, py - y) <= HIT_PX) return i;
    }
    return -1;
  }

  bindPointer() {
    const c = this.canvas;
    let press = null;
    const at = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener("pointerdown", (e) => {
      if (!this.view) return;
      const [px, py] = at(e);
      press = { px, py, x: px, y: py, wp: this.hit(px, py), moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      const [px, py] = at(e);
      if (!press) { c.style.cursor = this.hit(px, py) >= 0 ? "grab" : "crosshair"; return; }
      if (Math.hypot(px - press.px, py - press.py) > 4) press.moved = true;
      if (!press.moved) return;
      c.classList.add("dragging");
      if (press.wp >= 0) {
        const p = this.fromScreen(px, py);
        this.onMove(press.wp, p.lat, p.lon);
      } else {
        this.view.cx -= (px - press.x) / this.view.scale;
        this.view.cy += (py - press.y) / this.view.scale;
        press.x = px; press.y = py;
        this.draw();
      }
    });
    c.addEventListener("pointerup", (e) => {
      c.classList.remove("dragging");
      if (press && !press.moved && press.wp < 0) {
        const p = this.fromScreen(press.px, press.py);
        this.onAdd(p.lat, p.lon);
      }
      press = null;
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [px, py] = at(e);
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), px, py);
    }, { passive: false });
  }
}
