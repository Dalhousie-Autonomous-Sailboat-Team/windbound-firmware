/*
 * Arrows for the forces on the boat, the wind and its motion, drawn from the
 * same numbers the physics used in its last step (live_state()["forces"]).
 *
 * They live in the boat's frame (bow +Z, starboard -X, up +Y), level with the
 * water, so they turn with the boat but don't lean when it heels. They draw
 * over everything, so the keel's and rudder's forces show through the water.
 */
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const FORCE_M_PER_N = 0.12;
const WIND_M_PER_MS = 0.35;
const SPEED_M_PER_MS = 1.6;
const MIN_LENGTH_M = 0.08;
const MAX_LENGTH_M = 5;
const UP = new THREE.Vector3(0, 1, 0);

/* Body (forward u, starboard v) to the boat's frame. */
const local = (u, v) => new THREE.Vector3(-v, 0, u);

class Arrow {
  constructor(name, colorKey, origin) {
    this.name = name;
    this.colorKey = colorKey;
    this.material = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 10), this.material);
    this.head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.18, 14), this.material);
    this.shaft.renderOrder = this.head.renderOrder = 20;
    this.group = new THREE.Group();
    this.group.position.copy(origin);
    this.group.add(this.shaft, this.head);
    const tag = document.createElement("div");
    tag.className = "tag3d vec";
    tag.textContent = name;
    this.label = new CSS2DObject(tag);
    this.group.add(this.label);
  }
  hide() { this.group.visible = this.label.visible = false; }
  set(vector, scale) {
    const length = Math.min(vector.length() * scale, MAX_LENGTH_M);
    this.group.visible = this.label.visible = length >= MIN_LENGTH_M;
    if (!this.group.visible) return;
    const dir = vector.clone().normalize();
    const shaft = Math.max(length - 0.18, 0.01);
    const turn = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    this.shaft.quaternion.copy(turn);
    this.shaft.scale.set(1, shaft, 1);
    this.shaft.position.copy(dir).multiplyScalar(shaft / 2);
    this.head.quaternion.copy(turn);
    this.head.position.copy(dir).multiplyScalar(shaft + 0.09);
    this.label.position.copy(dir).multiplyScalar(length + 0.25);
  }
  recolor(p) { this.material.color.set(p[this.colorKey]); }
}

export class Vectors {
  constructor(geo) {
    this.group = new THREE.Group();
    const top = geo.wing.z_m + geo.wing.span_m / 2 + 0.25;
    this.sets = {
      forces: {
        lift: new Arrow("Lift", "accent", new THREE.Vector3(0, geo.wing.z_m, geo.wing.x_m)),
        drag: new Arrow("Drag", "accent", new THREE.Vector3(0, geo.wing.z_m, geo.wing.x_m)),
        keel: new Arrow("Keel", "caution", new THREE.Vector3(0, geo.keel.z_m, geo.keel.x_m)),
        rudder: new Arrow("Rudder", "caution", new THREE.Vector3(0, geo.rudder.z_m, geo.rudder.x_m)),
        hull: new Arrow("Hull drag", "caution", new THREE.Vector3(0, 0.05, -0.2)),
        net: new Arrow("Net", "text", new THREE.Vector3(0, 0.45, 0)),
      },
      wind: {
        true: new Arrow("True wind", "muted", new THREE.Vector3(0, top + 0.45, geo.wing.x_m)),
        apparent: new Arrow("Apparent", "text", new THREE.Vector3(0, top, geo.wing.x_m)),
      },
      motion: {
        velocity: new Arrow("Velocity", "text", new THREE.Vector3(0, 0.3, geo.hull.length_m / 2)),
      },
    };
    for (const set of Object.values(this.sets)) for (const arrow of Object.values(set)) this.group.add(arrow.group);
    this.show(new Set());
  }

  /* groups: which of "forces", "wind" and "motion" to draw. */
  show(groups) {
    this.visible = groups;
    this.group.visible = groups.size > 0;
    // Labels are page elements, drawn whether or not their arrow's group is.
    for (const [name, set] of Object.entries(this.sets)) {
      if (!groups.has(name)) for (const arrow of Object.values(set)) arrow.hide();
    }
  }

  recolor(p) {
    for (const set of Object.values(this.sets)) for (const arrow of Object.values(set)) arrow.recolor(p);
  }

  /* state: a live_state() snapshot. Returns the legend rows for what is shown. */
  update(s) {
    const f = s.forces, a = this.sets;
    const h = THREE.MathUtils.degToRad(s.heading);
    const to = THREE.MathUtils.degToRad(s.twd + 180);
    const wn = Math.cos(to) * s.tws, we = Math.sin(to) * s.tws;          // north/east velocity of the air
    const trueU = wn * Math.cos(h) + we * Math.sin(h), trueV = -wn * Math.sin(h) + we * Math.cos(h);
    const values = {
      forces: [["lift", f.wing_lift, FORCE_M_PER_N], ["drag", f.wing_drag, FORCE_M_PER_N],
               ["keel", f.keel, FORCE_M_PER_N], ["rudder", f.rudder, FORCE_M_PER_N],
               ["hull", f.hull, FORCE_M_PER_N], ["net", f.total, FORCE_M_PER_N]],
      wind: [["true", [trueU, trueV], WIND_M_PER_MS], ["apparent", s.flow, WIND_M_PER_MS]],
      motion: [["velocity", s.velocity, SPEED_M_PER_MS]],
    };
    for (const [setName, rows] of Object.entries(values)) {
      for (const [key, [u, v], scale] of rows) {
        const arrow = a[setName][key];
        if (this.visible.has(setName)) arrow.set(local(u, v), scale);
        else arrow.hide();
      }
    }
    const magnitude = ([u, v]) => Math.hypot(u, v);
    const legend = [];
    if (this.visible.has("forces")) {
      legend.push(["aero", "Lift", `${magnitude(f.wing_lift).toFixed(1)} N`],
                  ["aero", "Drag", `${magnitude(f.wing_drag).toFixed(1)} N`],
                  ["hydro", "Keel", `${magnitude(f.keel).toFixed(1)} N`],
                  ["hydro", "Rudder", `${magnitude(f.rudder).toFixed(1)} N`],
                  ["hydro", "Hull drag", `${magnitude(f.hull).toFixed(1)} N`],
                  ["net", "Net", `${magnitude(f.total).toFixed(1)} N`]);
    }
    if (this.visible.has("wind")) {
      legend.push(["wind", "True wind", `${s.tws.toFixed(1)} m/s`], ["net", "Apparent", `${s.aws.toFixed(1)} m/s`]);
    }
    if (this.visible.has("motion")) {
      const leeway = Math.abs(THREE.MathUtils.radToDeg(Math.atan2(s.velocity[1], s.velocity[0])));
      legend.push(["net", "Velocity", `${s.speed_ms.toFixed(2)} m/s`],
                  ["wind", "Leeway", s.speed_ms > 0.05 ? `${leeway.toFixed(1)}°` : "—"]);
    }
    return legend;
  }
}
