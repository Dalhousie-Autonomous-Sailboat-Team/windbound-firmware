/*
 * The 3D view of the simulated boat (three.js r160).
 *
 * The boat sits in two groups: one carries its position and heading (and the
 * force arrows, which stay level), the other leans it by its heel. Snapshots
 * arrive at up to 30 per second; the drawn boat eases toward each one so the
 * motion stays smooth at any simulation speed.
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
const deg = THREE.MathUtils.degToRad;
const wrapDeg = (d) => THREE.MathUtils.radToDeg(Math.atan2(Math.sin(deg(d)), Math.cos(deg(d))));

export class BoatView {
  constructor({ stage, canvas, labels, legend, onFrame }) {
    this.stage = stage;
    this.legendEl = legend;
    this.onFrame = onFrame;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.labels = new CSS2DRenderer();
    labels.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xffffff, 240, 1800);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 9000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 1200;

    this.hemi = new THREE.HemisphereLight();
    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 90 });
    this.sun.shadow.bias = -0.0004;
    this.sky = makeSky();
    this.streaks = makeWindStreaks();
    this.track = makeTrack();
    this.wake = makeWake();
    this.course = makeCourse();
    this.scene.add(this.hemi, this.sun, this.sun.target, this.sky.mesh, this.streaks.lines, this.track.group,
                   this.wake.mesh, this.course.group);

    this.yaw = new THREE.Group();          // position and heading
    this.heel = new THREE.Group();         // the lean
    this.yaw.add(this.heel);
    this.scene.add(this.yaw);
    const markerTag = Object.assign(document.createElement("div"), {
      className: "boat-marker",
      innerHTML: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 13 14 8 11 3 14Z"/></svg>',
    });
    this.marker = new CSS2DObject(markerTag);
    this.scene.add(this.marker);

    this.mode = "orbit";
    this.vectorGroups = new Set();
    this.shown = { north: 0, east: 0, heading: 0, heel: 0, sail: 0, rudder: 0, awa: 0 };
    this.latest = null;
    this.first = true;
    this.sinceLegend = LEGEND_INTERVAL_S;
    this.themeName = "light";
    this.clock = new THREE.Clock();
    new ResizeObserver(() => this.resize()).observe(stage);
  }

  /* A new run: rebuild what depends on the scenario. */
  async setScene(info) {
    for (const part of [this.water?.mesh, this.lake?.group, this.boat?.group, this.vectors?.group]) {
      if (part) part.parent.remove(part);
    }
    this.info = info;
    this.water = makeWater(Boolean(info.lake));
    this.scene.add(this.water.mesh);
    this.lake = info.lake ? makeLake(info.lake) : null;
    if (this.lake) this.scene.add(this.lake.group);
    this.boat = buildDefaultBoat(info.boat);
    this.modelNote = "Default boat drawn from params/windbound.toml";
    if (info.model) {
      try {
        const model = await loadModel(info.model);
        this.boat = model;
        const missing = ["wing", "rudder"].filter((part) => !model[part]);
        const size = model.length_m < 0.5 || model.length_m > 10
          ? ` It is ${model.length_m.toFixed(2)} m long; export it in metres.` : "";
        this.modelNote = missing.length ? `boat.glb has no part named ${missing.join(" or ")}, so it won't move.${size}`
          : `Boat model from boat.glb.${size}`;
      } catch (error) {
        this.modelNote = `Couldn't load boat.glb (${error.message}); showing the default boat.`;
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
    if (this.scene.environment) this.scene.environment.dispose();
    this.scene.environment = skyEnvironment(this.renderer, p);
    this.scene.fog.color.set(p.fog);
    this.sky.recolor(p);
    this.hemi.color.set(p.hemiSky); this.hemi.groundColor.set(p.hemiGround); this.hemi.intensity = p.hemi;
    this.sun.color.set(p.sun); this.sun.intensity = p.sunI;
    for (const part of [this.water, this.lake, this.streaks, this.track, this.wake, this.course, this.vectors]) {
      part?.recolor(p);
    }
    if (this.boat?.materials) {
      const m = this.boat.materials;
      for (const key of ["hull", "deck", "wing", "foil", "trim"]) m[key].color.set(p[key]);
      m.vane.color.set(p.accent);
    }
  }

  /* orbit: stay with the boat, drag to look from any side. chase: sit behind
     the boat and turn with it. top: straight down, north up. */
  setMode(mode) {
    this.mode = mode;
    const target = this.boatPosition();
    const c = this.controls;
    c.target.copy(target);
    c.enableRotate = mode === "orbit";
    // Looking straight down there is no horizon to fade, the ripples would tile,
    // and the boat is too small to see, so it gets a marker.
    this.scene.fog.near = mode === "top" ? 4000 : 240;
    this.scene.fog.far = mode === "top" ? 9000 : 1800;
    this.water?.detail(mode === "top" ? 0.2 : 1);
    this.marker.visible = mode === "top";
    if (mode === "top") {
      c.minPolarAngle = c.maxPolarAngle = 0.0001;
      c.minAzimuthAngle = c.maxAzimuthAngle = 0;     // north up
      this.camera.position.set(target.x, target.y + 260, target.z + 0.01);
    } else {
      c.minPolarAngle = 0.08;
      c.maxPolarAngle = 1.5;
      c.minAzimuthAngle = -Infinity;
      c.maxAzimuthAngle = Infinity;
      this.camera.position.copy(this.quarterView(target, 8.5));
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
      if (this.first) this.setMode(this.mode);
      this.first = false;
    }
  }

  boatPosition() { return toWorld(this.shown.north, this.shown.east, 0.9); }

  /* Off the starboard quarter and above, so the wing shows its shape. */
  quarterView(target, distance) {
    const h = deg(this.shown.heading), flat = distance * 0.93;
    const back = flat * Math.cos(deg(30)), out = flat * Math.sin(deg(30));
    return new THREE.Vector3(target.x - Math.sin(h) * back + Math.cos(h) * out, target.y + distance * 0.38,
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

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
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
    if (this.mode === "chase") {
      // Ease round to stay behind the boat as it turns; scrolling still zooms.
      const wanted = this.quarterView(position, this.camera.position.distanceTo(position));
      this.camera.position.lerp(wanted, 1 - Math.exp(-dt / 0.6));
    }
    this.controls.update();
    this.sky.mesh.position.copy(this.camera.position);

    this.sun.position.set(position.x - 18, 34, position.z + 22);
    this.sun.target.position.copy(position);
    const rate = s && !s.finished ? this.simSpeed || 8 : 0;
    if (s) {
      this.streaks.update(dt * rate, position, s.twd, s.tws);
      this.water?.drift(dt * rate, s.twd, s.tws);
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
  }
}
