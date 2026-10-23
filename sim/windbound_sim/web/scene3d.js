/*
 * The 3D view of the simulated boat (three.js r160).
 *
 * The boat sits in two groups: one carries its position and heading (and the
 * force arrows, which stay level), the other leans it by its heel. Snapshots
 * arrive at up to 30 per second; the drawn boat eases toward each one so the
 * motion stays smooth at any simulation speed.
 *
 * Rendering keeps itself cheap: it stops while the view is off screen, and
 * lowers its resolution when frames run long (raising it again when they
 * don't), so a laptop on battery still gets a smooth picture.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { buildDefaultBoat, loadModel, setPartAngle } from "/boat.js";
import { PALETTES, makeCourse, makeLake, makeSky, makeTrack, makeWake, makeWater, makeWindStreaks,
         skyEnvironment, toWorld } from "/world.js";
import { FORCE_M_PER_N, Vectors } from "/vectors.js";

const SMOOTHING_S = 0.09;
const LEGEND_INTERVAL_S = 0.15;
const TWEEN_S = 0.9;
const ORBIT_DISTANCE_M = 7.5;
const TOP_HEIGHT_M = 380;
const deg = THREE.MathUtils.degToRad;
const wrapDeg = (d) => THREE.MathUtils.radToDeg(Math.atan2(Math.sin(deg(d)), Math.cos(deg(d))));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class BoatView {
  constructor({ stage, canvas, labels, legend, onFrame }) {
    this.stage = stage;
    this.legendEl = legend;
    this.onFrame = onFrame;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.labels = new CSS2DRenderer();
    labels.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xffffff, 400, 3000);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.3, 12000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 1400;

    this.hemi = new THREE.HemisphereLight();
    this.sun = new THREE.DirectionalLight();
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 120 });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sky = makeSky();
    this.sunDirection = new THREE.Vector3();
    this.water = makeWater();
    this.streaks = makeWindStreaks();
    this.track = makeTrack();
    this.wake = makeWake();
    this.course = makeCourse();
    this.scene.add(this.hemi, this.sun, this.sun.target, this.sky.mesh, this.water.mesh, this.streaks.lines,
                   this.track.group, this.wake.mesh, this.course.group);

    this.yaw = new THREE.Group();          // position and heading
    this.heel = new THREE.Group();         // the lean
    this.yaw.add(this.heel);
    this.scene.add(this.yaw);
    const markerTag = Object.assign(document.createElement("div"), {
      className: "boat-marker",
      innerHTML: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 13 14 8 11 3 14Z"/></svg>',
    });
    this.marker = new CSS2DObject(markerTag);
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.mode = "orbit";
    this.tween = null;
    this.vectorGroups = new Set();
    this.shown = { north: 0, east: 0, heading: 0, heel: 0, sail: 0, rudder: 0, awa: 0 };
    this.latest = null;
    this.first = true;
    this.sinceLegend = LEGEND_INTERVAL_S;
    this.themeName = "light";
    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.pace = { time: 0, frames: 0, best: 1 / 60, calm: 0 };
    this.onScreen = true;
    new ResizeObserver(() => this.resize()).observe(stage);
    new IntersectionObserver(([entry]) => { this.onScreen = entry.isIntersecting; }).observe(stage);
  }

  /* A new run: rebuild what depends on the scenario. */
  async setScene(info) {
    for (const part of [this.lake?.group, this.boat?.group, this.vectors?.group]) {
      if (part) part.parent.remove(part);
    }
    this.info = info;
    this.lake = info.lake ? makeLake(info.lake) : null;
    if (this.lake) this.scene.add(this.lake.group);
    this.water.setDepth(info.lake);
    this.boat = buildDefaultBoat(info.boat);
    this.modelWarning = null;            // something wrong with boat.glb, said in the panel header
    if (info.model) {
      try {
        const model = await loadModel(info.model);
        this.boat = model;
        const missing = ["wing", "rudder"].filter((part) => !model[part]);
        const size = model.length_m < 0.5 || model.length_m > 10
          ? `boat.glb is ${model.length_m.toFixed(2)} m long; export it in metres.` : "";
        this.modelWarning = [missing.length ? `boat.glb has no part named ${missing.join(" or ")}, so it won't move.` : "",
                             size].filter(Boolean).join(" ") || null;
      } catch (error) {
        this.modelWarning = `Couldn't load boat.glb (${error.message}); showing the default boat.`;
      }
    }
    this.heel.add(this.boat.group);
    this.vectors = new Vectors(info.boat);
    this.vectors.show(this.vectorGroups);
    this.yaw.add(this.vectors.group);
    this.track.set([]);
    this.wake.reset();
    this.first = true;
    this.setTheme(this.themeName);
  }

  setTheme(name) {
    this.themeName = name;
    const p = PALETTES[name];
    this.palette = p;
    this.sky.recolor(p);
    if (this.scene.environment) this.scene.environment.dispose();
    this.scene.environment = skyEnvironment(this.renderer, this.sky);
    this.renderer.toneMappingExposure = p.exposure;
    this.scene.fog.color.set(p.fog);
    this.applyFog();
    this.hemi.color.set(p.hemiSky); this.hemi.groundColor.set(p.hemiGround); this.hemi.intensity = p.hemi;
    this.sun.color.set(p.sun); this.sun.intensity = p.sunI;
    this.sun.castShadow = p.sunElevation > 6;     // at dusk the shadows would run off the shadow map
    this.water.recolor(p);
    for (const part of [this.streaks, this.track, this.wake, this.course, this.vectors]) part?.recolor(p);
  }

  applyFog() {
    const p = this.palette;
    if (!p) return;
    this.scene.fog.near = this.mode === "top" ? 6000 : p.fogNear;
    this.scene.fog.far = this.mode === "top" ? 12000 : p.fogFar;
  }

  /* orbit: stay with the boat, drag to look from any side. chase: sit behind
     the boat and turn with it. top: straight down, north up. Moving between
     them glides rather than jumps. */
  setMode(mode, animate = true) {
    const previous = this.mode;
    this.mode = mode;
    const target = this.boatPosition();
    const c = this.controls;
    c.target.copy(target);
    // Looking straight down there is no horizon to fade, the ripples would tile,
    // and the boat is too small to see, so it gets a marker.
    this.applyFog();
    this.water.chart(mode === "top");
    this.marker.visible = mode === "top";
    // The track is the story of the run from above; beside the boat the wake tells it.
    this.track.material.opacity = mode === "top" ? 0.85 : 0.4;
    const distance = this.camera.position.distanceTo(target);
    let wanted = null;
    if (mode === "top") wanted = new THREE.Vector3(target.x, target.y + TOP_HEIGHT_M, target.z + 0.01);
    else if (mode === "chase") wanted = this.quarterView(target, Math.min(Math.max(distance, 5), 40));
    else if (previous === "top" || this.first) wanted = this.quarterView(target, ORBIT_DISTANCE_M);
    if (wanted && animate && !this.first && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(target));
      const to = new THREE.Spherical().setFromVector3(wanted.clone().sub(target));
      to.theta = from.theta + Math.atan2(Math.sin(to.theta - from.theta), Math.cos(to.theta - from.theta));
      this.tween = { from, to, t: 0 };
      c.enabled = false;
    } else {
      if (wanted) this.camera.position.copy(wanted);
      this.constrain();
    }
  }

  constrain() {
    const c = this.controls;
    c.enabled = true;
    c.enableRotate = this.mode === "orbit";
    if (this.mode === "top") {
      c.minPolarAngle = c.maxPolarAngle = 0.0001;
      c.minAzimuthAngle = c.maxAzimuthAngle = 0;     // north up
    } else {
      c.minPolarAngle = 0.08;
      c.maxPolarAngle = 1.52;
      c.minAzimuthAngle = -Infinity;
      c.maxAzimuthAngle = Infinity;
    }
    c.update();
  }

  setVectors(groups) {
    this.vectorGroups = groups;
    this.vectors?.show(groups);
    this.legendEl.hidden = groups.size === 0;
    this.sinceLegend = LEGEND_INTERVAL_S;
  }

  setRoute(route, origin) {
    const k = Math.PI / 180, r = 6371000;
    this.course.set(route.map(([lat, lon]) => ({
      north: (lat - origin[0]) * k * r,
      east: (lon - origin[1]) * k * r * Math.cos(origin[0] * k),
    })));
  }

  setTrack(points) { this.track.set(points); }

  push(state, simSpeed) {
    this.latest = state;
    this.simSpeed = simSpeed;
    this.track.add(state.north, state.east);
    if (this.first || Math.hypot(state.north - this.shown.north, state.east - this.shown.east) > 60) {
      Object.assign(this.shown, { north: state.north, east: state.east, heading: state.heading, heel: state.heel,
                                  sail: state.sail, rudder: state.rudder, awa: state.awa });
      this.streaks.recentre(this.boatPosition());
      this.wake.reset();
      if (this.first) this.setMode(this.mode, false);
      this.first = false;
    }
  }

  /* The point the camera looks at: the middle of the wing, so the boat sits
     low in the frame with the shore and the sky above it. */
  boatPosition() { return toWorld(this.shown.north, this.shown.east, 1.2); }

  /* Off the starboard quarter and a little above, so the wing shows its
     shape and the horizon stays in the picture. */
  quarterView(target, distance) {
    const h = deg(this.shown.heading), flat = distance * 0.97;
    const back = flat * Math.cos(deg(32)), out = flat * Math.sin(deg(32));
    return new THREE.Vector3(target.x - Math.sin(h) * back + Math.cos(h) * out, target.y + distance * 0.24,
                             target.z + Math.cos(h) * back + Math.sin(h) * out);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.stage;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.track.material.resolution.set(w, h);
    this.course.material.resolution.set(w, h);
  }

  start() {
    this.resize();
    this.clock.getDelta();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  stop() { this.renderer.setAnimationLoop(null); }

  /* Lower the resolution when frames run long; raise it again after a calm spell. */
  pacing(dt) {
    const pace = this.pace;
    pace.time += dt;
    pace.frames += 1;
    pace.best = Math.max(Math.min(pace.best, dt), 1 / 240);
    if (pace.time < 2) return;
    const average = pace.time / pace.frames;
    const target = Math.max(pace.best, 1 / 60);        // the display's rate, but 60 fps is plenty
    let next = this.pixelRatio;
    if (average > target * 1.35 && this.pixelRatio > 1) { next = Math.max(1, this.pixelRatio - 0.25); pace.calm = 0; }
    else if (average < target * 1.1) pace.calm += 1;
    if (pace.calm >= 4 && this.pixelRatio < this.maxPixelRatio) { next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25); pace.calm = 0; }
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
    Object.assign(pace, { time: 0, frames: 0, best: pace.best * 1.02 });    // let the estimate recover
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (!this.onScreen) return;
    this.elapsed += dt;
    this.pacing(dt);
    const s = this.latest, shown = this.shown;
    if (s) {
      const k = 1 - Math.exp(-dt / SMOOTHING_S);
      shown.north += (s.north - shown.north) * k;
      shown.east += (s.east - shown.east) * k;
      for (const key of ["heading", "heel", "sail", "rudder", "awa"]) shown[key] += wrapDeg(s[key] - shown[key]) * k;
    }
    const before = this.controls.target.clone();
    const position = this.boatPosition();
    this.yaw.position.set(position.x, 0, position.z);
    this.yaw.rotation.y = Math.PI - deg(shown.heading);        // the model's bow is +Z
    this.heel.rotation.z = deg(shown.heel);                     // heel to starboard lifts the port side (+X)
    if (this.boat) {
      setPartAngle(this.boat.wing, -deg(shown.sail));
      setPartAngle(this.boat.rudder, deg(shown.rudder));
      setPartAngle(this.boat.vane, -deg(shown.awa));
    }
    this.marker.position.set(position.x, 0, position.z);
    this.marker.element.firstChild.style.transform = `rotate(${shown.heading.toFixed(1)}deg)`;

    this.camera.position.add(position.clone().sub(before));
    this.controls.target.copy(position);
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(tw.t + dt / TWEEN_S, 1);
      const e = ease(tw.t);
      const sph = new THREE.Spherical(
        THREE.MathUtils.lerp(tw.from.radius, tw.to.radius, e),
        THREE.MathUtils.lerp(tw.from.phi, tw.to.phi, e),
        THREE.MathUtils.lerp(tw.from.theta, tw.to.theta, e));
      this.camera.position.copy(position).add(new THREE.Vector3().setFromSpherical(sph));
      this.camera.lookAt(position);
      if (tw.t >= 1) { this.tween = null; this.constrain(); }
    } else {
      if (this.mode === "chase") {
        // Ease round to stay behind the boat as it turns; scrolling still zooms.
        const wanted = this.quarterView(position, this.camera.position.distanceTo(position));
        this.camera.position.lerp(wanted, 1 - Math.exp(-dt / 0.6));
      }
      this.controls.update();
    }
    this.sky.mesh.position.copy(this.camera.position);

    // After sunset the light still comes from just above the hills, never from below.
    this.sunDirection.copy(this.sky.sun);
    if (this.sunDirection.y < 0.06) { this.sunDirection.y = 0.06; this.sunDirection.normalize(); }
    this.sun.position.copy(position).addScaledVector(this.sunDirection, 60);
    this.sun.target.position.copy(position);
    this.water.update(dt, s?.twd ?? 0, s?.tws ?? 3);
    this.course.bob(this.elapsed);
    const rate = s && !s.finished ? this.simSpeed || 8 : 0;
    if (s) {
      this.streaks.update(dt * rate, position, s.twd, s.tws);
      this.yaw.updateMatrixWorld();
      const stern = new THREE.Vector3(0, 0, -this.info.boat.hull.length_m / 2).applyMatrix4(this.yaw.matrixWorld);
      this.wake.update(stern, s.speed_ms);
      this.sinceLegend += dt;
      if (this.vectors && this.vectorGroups.size) {
        const rows = this.vectors.update(s);
        if (this.sinceLegend >= LEGEND_INTERVAL_S) {
          this.sinceLegend = 0;
          this.legendEl.innerHTML = rows.map(([kind, name, value]) =>
            `<div><span><i class="sw-${kind}"></i>${name}</span><b>${value}</b></div>`).join("")
            + (this.vectorGroups.has("forces")
               ? `<div class="scale"><span>1 m of arrow</span><b>${(1 / FORCE_M_PER_N).toFixed(1)} N</b></div>` : "");
        }
      }
    }
    this.onFrame?.(THREE.MathUtils.radToDeg(this.controls.getAzimuthalAngle()));
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    if (!this.stage.dataset.ready) this.stage.dataset.ready = "true";
  }
}
