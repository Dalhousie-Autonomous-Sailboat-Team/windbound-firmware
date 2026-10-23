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

const SECTIONS = 32;
const HALF_POINTS = 12;

/* Hull lines as fractions, s = 0 at the bow and 1 at the transom. */
function halfBeam(s, beam) {
  const fine = s < 0.55 ? Math.pow(Math.sin((s / 0.55) * Math.PI / 2), 0.75)
                        : 1 - 0.28 * Math.pow((s - 0.55) / 0.45, 2);
  return (beam / 2) * Math.max(fine, 0.004);
}
function sheer(s, freeboard) { return freeboard * (1 + 0.35 * Math.pow(1 - s, 2)); }
function bottom(s, depth) { return depth * (0.25 + 0.75 * Math.pow(Math.sin(Math.PI * Math.min(s / 0.95, 1)), 0.6)); }

function hullGeometry(h) {
  const { length_m: L, beam_m: B, freeboard_m: F, depth_m: D } = h;
  const positions = [];
  const index = [];
  const ring = HALF_POINTS * 2 + 1;
  for (let i = 0; i <= SECTIONS; i++) {
    const s = i / SECTIONS;
    const z = L / 2 - s * L;
    const b = halfBeam(s, B), top = sheer(s, F), keel = bottom(s, D);
    for (let j = 0; j < ring; j++) {
      const phi = (j / (ring - 1) - 0.5) * Math.PI;           // -90 deg (starboard) to +90 (port)
      const x = b * Math.sin(phi);
      const y = top * Math.pow(Math.abs(Math.sin(phi)), 6) - keel * Math.pow(Math.cos(phi), 1.3);
      positions.push(x, y, z);
    }
  }
  for (let i = 0; i < SECTIONS; i++) {
    for (let j = 0; j < ring - 1; j++) {
      const a = i * ring + j, b = a + ring;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Transom: a fan from the centre of the last section.
  const last = SECTIONS * ring;
  const centre = positions.length / 3;
  positions.push(0, sheer(1, F) * 0.4, -L / 2);
  for (let j = 0; j < ring - 1; j++) index.push(centre, last + j + 1, last + j);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function deckGeometry(h) {
  const { length_m: L, beam_m: B, freeboard_m: F } = h;
  const positions = [];
  const index = [];
  for (let i = 0; i <= SECTIONS; i++) {
    const s = i / SECTIONS;
    const z = L / 2 - s * L, b = halfBeam(s, B) * 0.985, y = sheer(s, F);
    positions.push(-b, y, z, 0, y + B * 0.02, z, b, y, z);    // starboard edge, camber, port edge
  }
  for (let i = 0; i < SECTIONS; i++) {
    const a = i * 3, n = a + 3;
    index.push(a, a + 1, n, a + 1, n + 1, n, a + 1, a + 2, n + 1, a + 2, n + 2, n + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/* A symmetric NACA 00xx foil, pivoting at its quarter chord, spanning up from y = 0. */
export function foilGeometry(chord, span, thickness = 0.12) {
  const top = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2;          // cosine spacing, dense at the nose
    const yt = 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x
                                + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    top.push([x * chord, yt * chord]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(top[n][0], 0);
  for (let i = n; i >= 0; i--) shape.lineTo(top[i][0], top[i][1]);
  for (let i = 1; i <= n; i++) shape.lineTo(top[i][0], -top[i][1]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(-0.25 * chord, 0, 0);
  geometry.rotateX(-Math.PI / 2);                             // span along +Y
  geometry.rotateY(Math.PI / 2);                              // leading edge forward (+Z)
  geometry.computeVertexNormals();
  return geometry;
}

export function buildDefaultBoat(geo) {
  const h = geo.hull;
  const materials = {
    hull: new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.02 }),
    deck: new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 }),
    wing: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, side: THREE.DoubleSide }),
    foil: new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 }),
    vane: new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0, side: THREE.DoubleSide }),
    trim: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 }),
  };
  const group = new THREE.Group();
  group.name = "Windbound (default)";

  const hull = new THREE.Mesh(hullGeometry(h), materials.hull);
  const deck = new THREE.Mesh(deckGeometry(h), materials.deck);
  hull.castShadow = deck.castShadow = true;
  group.add(hull, deck);

  const sAt = (z) => (h.length_m / 2 - z) / h.length_m;
  const bottomAt = (z) => -bottom(Math.min(Math.max(sAt(z), 0), 1), h.depth_m) * 0.92;

  const keelGeo = foilGeometry(geo.keel.chord_m, geo.keel.span_m, 0.12);
  keelGeo.translate(0, -geo.keel.span_m, 0);
  const keel = new THREE.Mesh(keelGeo, materials.foil);
  keel.position.set(0, bottomAt(geo.keel.x_m) + 0.02, geo.keel.x_m);
  keel.castShadow = true;
  group.add(keel);

  const rudderGeo = foilGeometry(geo.rudder.chord_m, geo.rudder.span_m, 0.12);
  rudderGeo.translate(0, -geo.rudder.span_m, 0);
  const rudder = new THREE.Mesh(rudderGeo, materials.foil);
  rudder.name = "rudder";
  rudder.position.set(0, bottomAt(geo.rudder.x_m) + 0.02, geo.rudder.x_m);
  rudder.castShadow = true;
  group.add(rudder);

  const deckY = sheer(sAt(geo.wing.x_m), h.freeboard_m);
  const wing = new THREE.Group();
  wing.name = "wing";
  wing.position.set(0, deckY + 0.1, geo.wing.x_m);
  const wingMesh = new THREE.Mesh(foilGeometry(geo.wing.chord_m, geo.wing.span_m, 0.14), materials.wing);
  wingMesh.castShadow = true;
  const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, geo.wing.span_m + 0.14, 12), materials.foil);
  spar.position.y = (geo.wing.span_m + 0.14) / 2 - 0.12;
  wing.add(wingMesh, spar);
  group.add(wing);

  // Masthead vane: a small upright flag that streams where the apparent wind
  // goes. It belongs to the boat, not the wing, so the sail doesn't turn it.
  const vane = new THREE.Group();
  vane.name = "vane";
  vane.position.set(0, wing.position.y + geo.wing.span_m + 0.06, geo.wing.x_m);
  const flagShape = new THREE.Shape();
  flagShape.moveTo(0, 0); flagShape.lineTo(-0.2, 0.04); flagShape.lineTo(-0.2, -0.04); flagShape.lineTo(0, 0);
  const flag = new THREE.Mesh(new THREE.ShapeGeometry(flagShape), materials.vane);
  flag.rotation.y = -Math.PI / 2;                             // upright, streaming aft (-Z)
  vane.add(flag);
  group.add(vane);

  // Details that make the shape read from any side: a rubbing strake along
  // each sheer, a hatch aft of the mast and a collar where the wing turns.
  for (const side of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= SECTIONS; i++) {
      const s = i / SECTIONS;
      points.push(new THREE.Vector3(side * halfBeam(s, h.beam_m), sheer(s, h.freeboard_m) - 0.012,
                                    h.length_m / 2 - s * h.length_m));
    }
    const strake = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.009, 6),
                                  materials.trim);
    group.add(strake);
  }
  const hatchZ = geo.wing.x_m - 0.42;
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(h.beam_m * 0.42, 0.03, 0.26), materials.trim);
  hatch.position.set(0, sheer(sAt(hatchZ), h.freeboard_m) + h.beam_m * 0.02, hatchZ);
  hatch.castShadow = true;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.1, 20), materials.foil);
  collar.position.set(0, deckY + 0.05, geo.wing.x_m);
  group.add(hatch, collar);

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
