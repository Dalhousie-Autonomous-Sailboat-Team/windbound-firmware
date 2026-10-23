/*
 * The boat in the 3D scene: either the default model, drawn from the same
 * dimensions the physics uses, or a boat.glb supplied by the team.
 *
 * Boat frame (glTF convention): metres, +Y up, the bow toward +Z, starboard
 * toward -X, the origin on the centreline at the waterline below the centre
 * of gravity. Parts that move rotate about their own vertical axis:
 *   wing    rotation.y = -sail      (sail positive: trailing edge to port, +X)
 *   rudder  rotation.y = +rudder    (rudder positive: turns to starboard)
 *   vane    rotation.y = -apparent wind angle (points where the air goes)
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const STATIONS = 56;       // sections from bow to transom
const HALF = 16;           // points from the keel up to each sheer
const ACROSS = 10;         // deck points from sheer to sheer

/* Hull lines as functions of s: 0 at the bow, 1 at the transom. */
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
function halfBeam(s, beam) {
  const fine = s < 0.58 ? Math.sin((s / 0.58) * Math.PI / 2) ** 0.7 : 1 - 0.24 * ((s - 0.58) / 0.42) ** 2;
  return (beam / 2) * Math.max(fine, 0.004);
}
const sheer = (s, freeboard) => freeboard * (1 + 0.36 * (1 - s) ** 2.2);
const keelDepth = (s, depth) => depth * (0.18 + 0.82 * Math.sin(Math.PI * Math.min(Math.max((s - 0.015) / 0.94, 0), 1)) ** 0.55);
const camber = (s, beam) => beam * 0.032 * Math.min(halfBeam(s, beam) / (beam / 2), 1);

/* One section, keel to sheer on one side: V-shaped at the bow, round-bilged
   amidships, with a little flare in the bow's topsides. Returns [x, y] pairs
   with x >= 0 (port); the starboard side mirrors it. */
function sectionPoints(s, h) {
  const b = halfBeam(s, h.beam_m), top = sheer(s, h.freeboard_m), keel = keelDepth(s, h.depth_m);
  const p = 1.5 + 1.4 * smooth(0.0, 0.55, s);           // superellipse exponent: V forward, round aft
  const points = [];
  for (let j = 0; j <= HALF; j++) {
    const theta = (j / HALF) * Math.PI / 2;
    const y = top - (top + keel) * Math.cos(theta) ** (2 / 2.2);
    const flare = 1 + 0.07 * Math.max(y / top, 0) * (1 - s);
    points.push([b * Math.sin(theta) ** (2 / p) * flare, y]);
  }
  return points;
}

/* Topsides and bottom as one smooth surface (its normals averaged); the deck
   and the transom are separate meshes so their edges stay crisp. */
function hullGeometry(h) {
  const L = h.length_m;
  const ring = HALF * 2 + 1;
  const positions = [];
  const index = [];
  for (let i = 0; i <= STATIONS; i++) {
    const s = i / STATIONS;
    const z = L / 2 - s * L;
    const half = sectionPoints(s, h);
    // Starboard sheer (-x) down to the keel, then up to the port sheer (+x).
    for (let j = HALF; j >= 1; j--) positions.push(-half[j][0], half[j][1], z);
    for (let j = 0; j <= HALF; j++) positions.push(half[j][0], half[j][1], z);
  }
  for (let i = 0; i < STATIONS; i++) {
    for (let j = 0; j < ring - 1; j++) {
      const a = i * ring + j, b = a + ring;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/* The transom: the last section closed across the top by the deck's camber,
   flat and facing aft. */
function transomGeometry(h) {
  const s = 1, z = -h.length_m / 2;
  const half = sectionPoints(s, h);
  const outline = [];
  for (let j = HALF; j >= 1; j--) outline.push([-half[j][0], half[j][1]]);
  for (let j = 0; j <= HALF; j++) outline.push([half[j][0], half[j][1]]);
  const b = half[HALF][0], top = half[HALF][1], c = camber(s, h.beam_m);
  for (let k = ACROSS - 1; k >= 1; k--) {                       // port to starboard across the deck edge
    const x = -b + (2 * b * k) / ACROSS;
    outline.push([x, top + c * (1 - (x / b) ** 2)]);
  }
  const centre = outline.reduce((acc, [x, y]) => [acc[0] + x / outline.length, acc[1] + y / outline.length], [0, 0]);
  const positions = [centre[0], centre[1], z];
  for (const [x, y] of outline) positions.push(x, y, z);
  const index = [];
  for (let k = 0; k < outline.length; k++) index.push(0, 1 + ((k + 1) % outline.length), 1 + k);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function deckGeometry(h) {
  const L = h.length_m;
  const positions = [];
  const index = [];
  for (let i = 0; i <= STATIONS; i++) {
    const s = i / STATIONS;
    const z = L / 2 - s * L, b = halfBeam(s, h.beam_m) * 0.995, y = sheer(s, h.freeboard_m), c = camber(s, h.beam_m);
    for (let k = 0; k <= ACROSS; k++) {
      const x = -b + (2 * b * k) / ACROSS;                       // starboard edge to port edge
      positions.push(x, y + c * (1 - (x / b) ** 2), z);
    }
  }
  const n = ACROSS + 1;
  for (let i = 0; i < STATIONS; i++) {
    for (let k = 0; k < ACROSS; k++) {
      const a = i * n + k, next = a + n;
      index.push(a, a + 1, next, a + 1, next + 1, next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/* A symmetric NACA 00xx foil (closed trailing edge), pivoting at its quarter
   chord, spanning up from y = 0, its tip chord `taper` times its root's. The
   leading edge points +Z. Smooth around the section, sharp at the trailing
   edge and the end caps. */
export function foilGeometry(chord, span, thickness = 0.12, taper = 1) {
  const n = 24;
  const point = (i, side) => {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2;          // 0 at the nose, 1 at the tail
    const yt = 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    return [side * yt * chord, (0.25 - x) * chord];           // [across, along]
  };
  const profile = [];
  for (let i = n; i >= 0; i--) profile.push(point(i, 1));    // tail to nose on the +X side
  for (let i = 1; i <= n; i++) profile.push(point(i, -1));   // nose to tail on the -X side
  const m = profile.length;
  const positions = [];
  const index = [];
  const ring = (y, f) => { for (const [x, z] of profile) positions.push(x * f, y, z * f); };
  ring(0, 1);
  ring(span, taper);
  for (let k = 0; k < m - 1; k++) index.push(k, m + k, k + 1, k + 1, m + k, m + k + 1);
  for (const [y, f, up] of [[0, 1, false], [span, taper, true]]) {
    const base = positions.length / 3;
    ring(y, f);
    for (let k = 1; k < m - 1; k++) {
      if (up) index.push(base, base + k + 1, base + k);
      else index.push(base, base + k, base + k + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/* A rounded rectangle, extruded upward: hatches and pads. */
function roundedSlab(width, length, height, radius) {
  const shape = new THREE.Shape();
  const w = width / 2, l = length / 2, r = Math.min(radius, w, l);
  shape.moveTo(-w + r, -l);
  shape.lineTo(w - r, -l); shape.quadraticCurveTo(w, -l, w, -l + r);
  shape.lineTo(w, l - r); shape.quadraticCurveTo(w, l, w - r, l);
  shape.lineTo(-w + r, l); shape.quadraticCurveTo(-w, l, -w, l - r);
  shape.lineTo(-w, -l + r); shape.quadraticCurveTo(-w, -l, -w + r, -l);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelThickness: height * 0.4,
                                                      bevelSize: height * 0.4, bevelSegments: 2, curveSegments: 6 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/* The hull's paint: white topsides, a boot stripe above the waterline and a
   dark bottom, by height in the boat's frame. */
function paintHull(material, colours) {
  material.userData.paint = {
    stripe: { value: new THREE.Color(colours.stripe) },
    bottom: { value: new THREE.Color(colours.bottom) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.paint);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHullY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHullY = position.y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vHullY;\nuniform vec3 stripe;\nuniform vec3 bottom;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        float aa = fwidth(vHullY) * 0.75;
        float below = 1.0 - smoothstep(0.018 - aa, 0.018 + aa, vHullY);
        float band = smoothstep(0.018 - aa, 0.018 + aa, vHullY) * (1.0 - smoothstep(0.07 - aa, 0.07 + aa, vHullY));
        diffuseColor.rgb = mix(diffuseColor.rgb, stripe, band);
        diffuseColor.rgb = mix(diffuseColor.rgb, bottom, below);`);
  };
}

export const BOAT_COLOURS = {
  topsides: 0xf3f4f1, stripe: 0x1b6c80, bottom: 0x23292d, deck: 0xd6d9d4, wing: 0xf4f5f2,
  foil: 0x262c30, trim: 0x15191b, hatch: 0xb9beba, vane: 0x1b6c80,
};

export function buildDefaultBoat(geo) {
  const h = geo.hull;
  const c = BOAT_COLOURS;
  const materials = {
    hull: new THREE.MeshPhysicalMaterial({ color: c.topsides, roughness: 0.34, clearcoat: 0.9, clearcoatRoughness: 0.1 }),
    deck: new THREE.MeshStandardMaterial({ color: c.deck, roughness: 0.82 }),
    wing: new THREE.MeshPhysicalMaterial({ color: c.wing, roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.3 }),
    foil: new THREE.MeshStandardMaterial({ color: c.foil, roughness: 0.4, metalness: 0.15 }),
    trim: new THREE.MeshStandardMaterial({ color: c.trim, roughness: 0.55 }),
    hatch: new THREE.MeshStandardMaterial({ color: c.hatch, roughness: 0.6 }),
    vane: new THREE.MeshStandardMaterial({ color: c.vane, roughness: 0.5, side: THREE.DoubleSide }),
  };
  paintHull(materials.hull, c);

  const group = new THREE.Group();
  group.name = "Windbound (default)";
  const add = (mesh, shadow = true) => { mesh.castShadow = shadow; group.add(mesh); return mesh; };
  add(new THREE.Mesh(hullGeometry(h), materials.hull));
  add(new THREE.Mesh(transomGeometry(h), materials.hull));
  add(new THREE.Mesh(deckGeometry(h), materials.deck));

  const sAt = (z) => Math.min(Math.max((h.length_m / 2 - z) / h.length_m, 0), 1);
  const bottomAt = (z) => -keelDepth(sAt(z), h.depth_m) * 0.94;
  const deckAt = (z) => sheer(sAt(z), h.freeboard_m) + camber(sAt(z), h.beam_m);

  // Keel and rudder hang down from the hull: turned half round about the
  // fore-and-aft axis, so the root stays at the hull and the nose forward.
  const keelGeo = foilGeometry(geo.keel.chord_m, geo.keel.span_m, 0.12, 0.72).rotateZ(Math.PI);
  const keel = add(new THREE.Mesh(keelGeo, materials.foil));
  keel.position.set(0, bottomAt(geo.keel.x_m) + 0.015, geo.keel.x_m);

  const rudderGeo = foilGeometry(geo.rudder.chord_m, geo.rudder.span_m, 0.12, 0.8).rotateZ(Math.PI);
  const rudder = add(new THREE.Mesh(rudderGeo, materials.foil));
  rudder.name = "rudder";
  rudder.position.set(0, bottomAt(geo.rudder.x_m) + 0.015, geo.rudder.x_m);

  // The wing turns about its spar; the collar and the spar's foot stay with the hull.
  const wingFoot = deckAt(geo.wing.x_m);
  const wing = new THREE.Group();
  wing.name = "wing";
  wing.position.set(0, wingFoot + 0.1, geo.wing.x_m);
  const wingMesh = new THREE.Mesh(foilGeometry(geo.wing.chord_m, geo.wing.span_m, 0.15, 0.78), materials.wing);
  wingMesh.castShadow = true;
  const sparLength = geo.wing.span_m + 0.16;
  const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.022, sparLength, 16), materials.foil);
  spar.position.y = sparLength / 2 - 0.12;
  spar.castShadow = true;
  wing.add(wingMesh, spar);
  group.add(wing);

  const collar = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.068, 0.1, 28), materials.trim));
  collar.position.set(0, wingFoot + 0.04, geo.wing.x_m);

  // Masthead vane: an arrow that streams where the apparent wind goes. It
  // belongs to the boat, not the wing, so the sail doesn't turn it.
  const vane = new THREE.Group();
  vane.name = "vane";
  vane.position.set(0, wing.position.y + geo.wing.span_m + 0.07, geo.wing.x_m);
  const arrow = new THREE.Shape();
  arrow.moveTo(0.05, 0); arrow.lineTo(-0.16, 0.035); arrow.lineTo(-0.2, 0.06); arrow.lineTo(-0.2, -0.06);
  arrow.lineTo(-0.16, -0.035); arrow.lineTo(0.05, 0);
  const flag = new THREE.Mesh(new THREE.ShapeGeometry(arrow), materials.vane);
  flag.rotation.y = -Math.PI / 2;                             // upright, streaming aft (-Z)
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.14, 8), materials.trim);
  pin.position.y = -0.04;
  vane.add(flag, pin);
  group.add(vane);

  // A rubbing strake along each sheer and a hatch aft of the wing, so the
  // shape reads from any side.
  for (const side of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= STATIONS; i++) {
      const s = i / STATIONS;
      const half = sectionPoints(s, h)[HALF];
      points.push(new THREE.Vector3(side * half[0] * 1.004, half[1] - 0.008, h.length_m / 2 - s * h.length_m));
    }
    add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 96, 0.008, 8), materials.trim), false);
  }
  const hatchZ = geo.wing.x_m - 0.46;
  const hatch = add(new THREE.Mesh(roundedSlab(h.beam_m * 0.44, 0.28, 0.012, 0.04), materials.hatch));
  hatch.position.set(0, deckAt(hatchZ) - 0.002, hatchZ);

  return { group, wing, rudder, vane, materials, source: "default" };
}

/*
 * Load a team-supplied model. Parts are found by name (case-insensitive):
 * "wing" (or "sail" / "mast"), "rudder" and, optionally, "vane".
 */
export async function loadModel(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  const find = (pattern) => {
    let found = null;
    root.traverse((node) => { if (!found && pattern.test(node.name)) found = node; });
    return found;
  };
  root.traverse((node) => { if (node.isMesh) node.castShadow = true; });
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const parts = { wing: find(/wing|sail|mast/i), rudder: find(/rudder/i), vane: find(/vane/i) };
  for (const part of Object.values(parts)) if (part) part.userData.restQuaternion = part.quaternion.clone();
  return { group: root, ...parts, materials: null, source: "glb", length_m: Math.max(size.x, size.z) };
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const turn = new THREE.Quaternion();

/* Turn a part about the boat's vertical axis, keeping any rest orientation it was modelled with. */
export function setPartAngle(part, radians) {
  if (!part) return;
  const rest = part.userData.restQuaternion;
  if (rest) {
    turn.setFromAxisAngle(Y_AXIS, radians);
    part.quaternion.copy(rest).premultiply(turn);
  } else {
    part.rotation.y = radians;
  }
}
