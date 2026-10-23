/*
 * Small SVG instruments for Mission control: the sail dial, the rudder bar
 * and the compass. Signs follow the simulator: sail angle positive with the
 * wing's trailing edge to port; rudder positive turning to starboard.
 */
const SVG = "http://www.w3.org/2000/svg";
const MINUS = "−";

function el(name, attrs, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.appendChild(node);
  return node;
}

/* The wing's true angle, what the firmware reads from its encoder, and its target. Bow up. */
export class SailDial {
  constructor(svg) {
    this.cx = 148; this.cy = 36; this.r = 88;
    el("path", { class: "mk-hull", d: "M148 4C168 20 176 50 174 90L170 132H126L122 90C120 50 128 20 148 4Z" }, svg);
    const [a, b] = [this.point(45, this.r), this.point(-45, this.r)];
    el("path", { class: "mk-range", d: `M${a.x} ${a.y}A${this.r} ${this.r} 0 0 0 ${b.x} ${b.y}` }, svg);
    for (const [deg, text, anchor] of [[45, "+45° port", "end"], [-45, `${MINUS}45° stbd`, "start"]]) {
      const p = this.point(deg, this.r), q = this.point(deg, this.r + 6);
      el("line", { class: "mk-tick", x1: p.x, y1: p.y, x2: q.x, y2: q.y }, svg);
      el("text", { class: "mk-label", x: q.x + (anchor === "end" ? -4 : 4), y: q.y + 13, "text-anchor": anchor }, svg)
        .textContent = text;
    }
    el("text", { class: "mk-label", x: 148, y: 148, "text-anchor": "middle" }, svg).textContent = "What the joystick sends";
    this.target = el("line", { class: "mk-target" }, svg);
    this.read = el("line", { class: "mk-read" }, svg);
    this.wing = el("line", { class: "mk-true" }, svg);
    el("circle", { class: "mk-pivot", cx: this.cx, cy: this.cy, r: 3.5 }, svg);
  }
  point(deg, radius) {
    const a = (deg * Math.PI) / 180;
    return { x: +(this.cx - radius * Math.sin(a)).toFixed(1), y: +(this.cy + radius * Math.cos(a)).toFixed(1) };
  }
  aim(line, deg) {
    const p = this.point(deg, this.r - 4);
    line.setAttribute("x1", this.cx); line.setAttribute("y1", this.cy);
    line.setAttribute("x2", p.x); line.setAttribute("y2", p.y);
  }
  draw(s) { this.aim(this.target, s.sail_target); this.aim(this.read, s.sail_believed); this.aim(this.wing, s.sail); }
}

/* Rudder angle against the firmware's target: 45 degrees to port on the left, starboard on the right. */
export class RudderBar {
  constructor(svg) {
    this.x0 = 14; this.x1 = 282; this.y = 16;
    el("line", { class: "mk-track", x1: this.x0, y1: this.y, x2: this.x1, y2: this.y }, svg);
    for (const [deg, text, anchor] of [[-45, "45° port", "start"], [0, "0", "middle"], [45, "45° stbd", "end"]]) {
      const x = this.x(deg);
      el("line", { class: "mk-tick", x1: x, y1: this.y + 7, x2: x, y2: this.y + 12 }, svg);
      el("text", { class: "mk-label", x: deg === -45 ? this.x0 : deg === 45 ? this.x1 : x, y: this.y + 29,
                   "text-anchor": anchor }, svg).textContent = text;
    }
    this.target = el("line", { class: "mk-target", y1: this.y - 13, y2: this.y + 13 }, svg);
    this.rudder = el("line", { class: "mk-true", y1: this.y - 8, y2: this.y + 8 }, svg);
  }
  x(deg) { return +(this.x0 + ((Math.max(-50, Math.min(50, deg)) + 45) / 90) * (this.x1 - this.x0)).toFixed(1); }
  draw(s) {
    for (const [line, deg] of [[this.target, s.rudder_target], [this.rudder, s.rudder]]) {
      const x = this.x(deg);
      line.setAttribute("x1", x); line.setAttribute("x2", x);
    }
  }
}

/* The boat and the true wind on a compass turned to match the 3D view. */
export class Compass {
  constructor(svg) {
    this.c = 60; this.r = 52;
    el("circle", { class: "mk-ring", cx: 60, cy: 60, r: this.r }, svg);
    this.dial = el("g", {}, svg);
    for (let d = 0; d < 360; d += 30) {
      const p = this.at(d, this.r), q = this.at(d, this.r - (d % 90 ? 4 : 8));
      el("line", { class: "mk-tick", x1: p.x, y1: p.y, x2: q.x, y2: q.y }, this.dial);
    }
    this.wind = el("line", { class: "mk-wind" }, this.dial);
    this.windHead = el("path", { class: "mk-wind-head" }, this.dial);
    this.boat = el("path", { class: "mk-pivot", d: "M0 -15L6 9L0 5L-6 9Z" }, this.dial);
    this.letters = [[0, "N"], [90, "E"], [180, "S"], [270, "W"]].map(([deg, text]) => {
      const node = el("text", { class: "mk-label" + (deg === 0 ? " strong" : ""), "text-anchor": "middle" }, svg);
      node.textContent = text;
      return [deg, node];
    });
    this.orient(0);
  }
  at(deg, radius) {
    const a = (deg * Math.PI) / 180;
    return { x: +(this.c + radius * Math.sin(a)).toFixed(1), y: +(this.c - radius * Math.cos(a)).toFixed(1) };
  }
  /* Called every frame with the camera's azimuth, so north on the dial is north on screen. */
  orient(azimuthDeg) {
    this.dial.setAttribute("transform", `rotate(${azimuthDeg.toFixed(1)} 60 60)`);
    for (const [deg, node] of this.letters) {
      const p = this.at(deg + azimuthDeg, this.r - 17);
      node.setAttribute("x", p.x); node.setAttribute("y", p.y + 4);
    }
  }
  draw(s) {
    this.boat.setAttribute("transform", `translate(60 60) rotate(${s.heading.toFixed(1)})`);
    const from = this.at(s.twd, this.r + 8), tip = this.at(s.twd, this.r - 24);
    this.wind.setAttribute("x1", from.x); this.wind.setAttribute("y1", from.y);
    this.wind.setAttribute("x2", tip.x); this.wind.setAttribute("y2", tip.y);
    const a = ((s.twd + 180) * Math.PI) / 180;
    const ux = Math.sin(a), uy = -Math.cos(a);
    const head = [[tip.x + ux * 7, tip.y + uy * 7], [tip.x - uy * 5, tip.y + ux * 5], [tip.x + uy * 5, tip.y - ux * 5]];
    this.windHead.setAttribute("d", `M${head.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L")}Z`);
  }
}
