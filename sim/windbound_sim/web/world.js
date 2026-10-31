/*
 * Everything around the boat: the sky and its sun, the water, the lake bed
 * and the land and trees around it, the wind on the water, the boat's track
 * and wake, and the planned course.
 *
 * World frame: metres, x east, y up, z south (so north is -z). Positions from
 * the simulator are north/east of the scenario origin; toWorld() converts.
 */
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const toWorld = (north, east, y = 0) => new THREE.Vector3(east, y, -north);

const LAND_Y = 0.6;
const TRACK_Y = 0.12;            // above the ripples, so lines don't flicker into the water
const WATER_SIZE_M = 7000;
const deg = THREE.MathUtils.degToRad;

/* The scene per theme. Light is a clear afternoon on the lake; dark is the
   blue hour just after sunset, the sun a few degrees below the hills.
   Colours that belong to the page (the accent, the caution amber, the text)
   match its tokens. */
export const PALETTES = {
  light: {
    sunElevation: 34, sunAzimuth: 208, turbidity: 2.8, rayleigh: 1.35, mie: 0.004, mieG: 0.8,
    exposure: 0.5, fog: 0xc3d3de, fogNear: 600, fogFar: 3600,
    sun: 0xfff1de, sunI: 3.4, hemiSky: 0xd8e6ee, hemiGround: 0x4c5944, hemi: 1.15,
    water: 0x1d4c5a, shallows: 0x4f8f88, waterRoughness: 0.13,
    foam: 0xffffff, streak: 0xffffff, streakOpacity: 0.32, track: 0x171717, idle: 0xf2f2ee,
    accent: 0x0b69a6, caution: 0xd6951a, text: 0x171717, muted: 0x5c5c64,
  },
  dark: {
    sunElevation: -2.6, sunAzimuth: 248, turbidity: 2.2, rayleigh: 3.6, mie: 0.003, mieG: 0.82,
    exposure: 1.45, fog: 0x283447, fogNear: 300, fogFar: 2600,
    sun: 0xffcaa0, sunI: 0.55, hemiSky: 0x6d84a8, hemiGround: 0x0b0f12, hemi: 1.3,
    water: 0x0d1f27, shallows: 0x22483f, waterRoughness: 0.12,
    foam: 0xdfe9ec, streak: 0xffffff, streakOpacity: 0.2, track: 0xededef, idle: 0xc9cfcc,
    accent: 0x5aaee3, caution: 0xe5a83b, text: 0xededef, muted: 0xa3a3ab,
  },
};

/* ----- small helpers ------------------------------------------------------ */

function rng(seed) {                    // mulberry32: the same scene every load
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => (0.5 * valueNoise(x, y) + 0.25 * valueNoise(2.03 * x + 17, 2.03 * y + 5)
                       + 0.125 * valueNoise(4.07 * x - 3, 4.07 * y + 11)) / 0.875;
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

/* ----- sky ---------------------------------------------------------------- */

export function makeSky() {
  const sky = new Sky();
  sky.scale.setScalar(9000);
  const sun = new THREE.Vector3();
  return {
    mesh: sky,
    sun,                                 // unit vector toward the sun
    recolor(p) {
      const u = sky.material.uniforms;
      u.turbidity.value = p.turbidity;
      u.rayleigh.value = p.rayleigh;
      u.mieCoefficient.value = p.mie;
      u.mieDirectionalG.value = p.mieG;
      // Azimuth clockwise from north; north is -z, east +x.
      sun.setFromSphericalCoords(1, deg(90 - p.sunElevation), Math.PI - deg(p.sunAzimuth));
      u.sunPosition.value.copy(sun);
    },
  };
}

/* The sky, blurred, for reflections on the hull and the wing. */
export function skyEnvironment(renderer, sky) {
  const room = new THREE.Scene();
  const parent = sky.mesh.parent;
  room.add(sky.mesh);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(room, 0.04);
  pmrem.dispose();
  if (parent) parent.add(sky.mesh);
  return target.texture;
}

/* ----- water -------------------------------------------------------------- */

/* A tileable normal map of small ripples, drawn once from a sum of waves. */
function rippleNormals(size = 256, seed = 7) {
  const random = rng(seed);
  const waves = [];
  for (let i = 0; i < 44; i++) {
    const angle = random() * Math.PI * 2, k = 3 + Math.floor(random() ** 1.3 * 34);
    const kx = Math.round(Math.cos(angle) * k), ky = Math.round(Math.sin(angle) * k);
    if (kx || ky) waves.push([kx, ky, 1 / Math.hypot(kx, ky) ** 1.35, random() * Math.PI * 2]);
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const k = (2 * Math.PI) / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const [kx, ky, a, phase] of waves) {
        const c = Math.cos(k * (kx * x + ky * y) + phase) * a * 0.32;
        dx += c * kx; dy += c * ky;
      }
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      image.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      image.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/*
 * The water: a PBR surface that reflects the sky (the scene's environment),
 * lit by the sun, with ripples at two scales that drift downwind and smooth
 * out with distance (so far water reads as a mirror, as it does from a boat).
 * Over a lake its colour follows the real depth grid: lighter over the
 * shallows, dark over deep water, so you can see where the keel would touch.
 */
export function makeWater() {
  const ripples = rippleNormals();
  ripples.anisotropy = 8;
  const uniforms = {
    rippleMap: { value: ripples },
    rippleA: { value: new THREE.Vector2() }, rippleB: { value: new THREE.Vector2() },
    rippleStrength: { value: 1 },
    deep: { value: new THREE.Color() }, shallow: { value: new THREE.Color() },
    depthMap: { value: null }, depthBox: { value: new THREE.Vector4(0, 0, 1, 1) }, hasDepth: { value: 0 },
    chart: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.14, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterWorld;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vWaterWorld;
        uniform sampler2D rippleMap; uniform vec2 rippleA; uniform vec2 rippleB; uniform float rippleStrength;
        uniform vec3 deep; uniform vec3 shallow;
        uniform sampler2D depthMap; uniform vec4 depthBox; uniform float hasDepth; uniform float chart;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float lakeDepth = 9.0;
        if (hasDepth > 0.5) {
          vec2 duv = vec2((vWaterWorld.x - depthBox.x) / depthBox.z, (-vWaterWorld.z - depthBox.y) / depthBox.w);
          if (all(greaterThan(duv, vec2(0.0))) && all(lessThan(duv, vec2(1.0)))) lakeDepth = texture2D(depthMap, duv).r * 8.0;
        }
        vec3 shallows = mix(shallow, shallow * 1.6 + 0.04, chart);
        diffuseColor.rgb = mix(shallows, deep, smoothstep(0.4, mix(4.5, 6.0, chart), lakeDepth));`)
      .replace("#include <normal_fragment_maps>", `
        float far = length(vWaterWorld - cameraPosition);
        float fade = rippleStrength / (1.0 + far / 55.0);
        vec3 r1 = texture2D(rippleMap, vWaterWorld.xz / 3.1 + rippleA).xyz * 2.0 - 1.0;
        vec3 r2 = texture2D(rippleMap, vWaterWorld.xz / 9.7 + rippleB).xyz * 2.0 - 1.0;
        vec2 slope = (r1.xy / r1.z) * 0.9 + (r2.xy / r2.z) * 0.6;
        vec3 waterNormal = normalize(vec3(-slope.x * fade, 1.0, slope.y * fade));
        normal = normalize((viewMatrix * vec4(waterNormal, 0.0)).xyz);`);
  };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(WATER_SIZE_M, WATER_SIZE_M), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return {
    mesh,
    /* The ripples drift downwind, the small ones faster. */
    update(dt, windFromDeg = 0, speed = 3) {
      const to = deg(windFromDeg + 180);
      const ex = Math.sin(to), north = Math.cos(to);
      const drift = dt * (0.15 + speed * 0.06);
      uniforms.rippleA.value.x -= (ex * drift) / 3.1; uniforms.rippleA.value.y -= (-north * drift) / 3.1;
      uniforms.rippleB.value.x -= (ex * drift * 0.6) / 9.7; uniforms.rippleB.value.y -= (-north * drift * 0.6) / 9.7;
    },
    /* Seen from straight above it reads as a depth chart: the small ripples
       (which would shimmer into noise) and the sky's reflection fade, and the
       shallows show stronger. */
    chart(on) {
      uniforms.rippleStrength.value = on ? 0.2 : 1;
      uniforms.chart.value = on ? 1 : 0;
      material.envMapIntensity = on ? 0.3 : 1;
    },
    /* The lake's depth grid (as sent in /api/scene), or null for open water. */
    setDepth(lake) {
      uniforms.depthMap.value?.dispose();
      uniforms.depthMap.value = null;
      uniforms.hasDepth.value = 0;
      if (!lake) return;
      const data = new Uint8Array(lake.rows * lake.cols * 4);
      lake.depth.forEach((d, i) => {
        const v = d === null ? 0 : Math.min(Math.round((Math.max(d, 0) / 8) * 255), 255);
        data.set([v, v, v, 255], i * 4);
      });
      const texture = new THREE.DataTexture(data, lake.cols, lake.rows);
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.flipY = false;
      texture.needsUpdate = true;
      uniforms.depthMap.value = texture;
      // Row 0 is the north edge; u runs east, v runs south.
      uniforms.depthBox.value.set(lake.left, lake.top, lake.right - lake.left, lake.bottom - lake.top);
      uniforms.hasDepth.value = 1;
    },
    recolor(p) {
      uniforms.deep.value.set(p.water);
      uniforms.shallow.value.set(p.shallows);
      material.roughness = p.waterRoughness;
    },
  };
}

/* ----- the lake and the land around it ------------------------------------ */

const BED_SHALLOW = new THREE.Color(0xb3a273), BED_DEEP = new THREE.Color(0x173238);
const SHORE = new THREE.Color(0x8d8670), MEADOW = new THREE.Color(0x6c7a48), WOODS = new THREE.Color(0x3a4529);
const RIDGE = new THREE.Color(0x56603d);

/*
 * The lake bed from the depth grid (corners in north/east metres: top,
 * bottom, left, right), and land rising from its shore into wooded hills,
 * padded on every side so the hills don't stop at the grid's edge.
 */
export function makeLake(lake) {
  const { rows, cols, depth } = lake;
  const cellN = (lake.top - lake.bottom) / (rows - 1), cellE = (lake.right - lake.left) / (cols - 1);
  const pad = Math.ceil(320 / Math.min(cellN, cellE));
  const R = rows + 2 * pad, C = cols + 2 * pad;
  const at = (r, c) => r * C + c;
  const water = new Uint8Array(R * C), bed = new Float32Array(R * C);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = depth[r * cols + c];
      if (d !== null) { water[at(r + pad, c + pad)] = 1; bed[at(r + pad, c + pad)] = d; }
    }
  }

  // Distance from the water, in metres (two-pass chamfer).
  const dist = new Float32Array(R * C).fill(1e9);
  for (let i = 0; i < R * C; i++) if (water[i]) dist[i] = 0;
  const diag = Math.hypot(cellN, cellE);
  const relax = (i, j, step) => { if (dist[j] + step < dist[i]) dist[i] = dist[j] + step; };
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const i = at(r, c);
      if (r > 0) { relax(i, i - C, cellN); if (c > 0) relax(i, i - C - 1, diag); if (c < C - 1) relax(i, i - C + 1, diag); }
      if (c > 0) relax(i, i - 1, cellE);
    }
  }
  for (let r = R - 1; r >= 0; r--) {
    for (let c = C - 1; c >= 0; c--) {
      const i = at(r, c);
      if (r < R - 1) { relax(i, i + C, cellN); if (c > 0) relax(i, i + C - 1, diag); if (c < C - 1) relax(i, i + C + 1, diag); }
      if (c < C - 1) relax(i, i + 1, cellE);
    }
  }

  const HILLS_M = 9, EDGE_Y = LAND_Y + HILLS_M * 0.62;
  const positions = new Float32Array(R * C * 3), colors = new Float32Array(R * C * 3);
  const heights = new Float32Array(R * C);
  const tmp = new THREE.Color();
  for (let r = 0; r < R; r++) {
    const north = lake.top - (r - pad) * cellN;
    for (let c = 0; c < C; c++) {
      const east = lake.left + (c - pad) * cellE;
      const i = at(r, c);
      let y;
      if (water[i]) {
        y = -Math.max(bed[i], 0.2);
        tmp.copy(BED_SHALLOW).lerp(BED_DEEP, Math.min(bed[i] / 5.5, 1) ** 0.6);
      } else {
        const d = dist[i];
        const broad = fbm(east / 230, north / 230), fine = fbm(east / 48 + 7, north / 48 - 3);
        y = LAND_Y + 0.4 * smooth(0, 16, d) + HILLS_M * smooth(10, 300, d) * (0.4 + 0.8 * broad)
            + 1.4 * (fine - 0.5) * smooth(8, 50, d);
        const border = Math.min(r, c, R - 1 - r, C - 1 - c);
        y = EDGE_Y + (y - EDGE_Y) * smooth(0, 6, border);
        const wood = smooth(0.4, 0.62, fbm(east / 150 + 31, north / 150 - 9));
        tmp.copy(MEADOW).lerp(WOODS, wood).lerp(RIDGE, smooth(5, 11, y) * 0.35).lerp(SHORE, 1 - smooth(4, 14, d));
        tmp.multiplyScalar(0.92 + 0.16 * fine);
      }
      heights[i] = y;
      positions.set([east, y, -north], i * 3);
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
  }
  const index = new Uint32Array((R - 1) * (C - 1) * 6);
  let k = 0;
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C - 1; c++) {
      const a = at(r, c), b = a + C;
      index.set([a, b, a + 1, a + 1, b, b + 1], k);
      k += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  const ground = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = false;

  // Flat country beyond the padded grid, at the height its border blends to.
  const north0 = lake.top + pad * cellN, north1 = lake.bottom - pad * cellN;
  const east0 = lake.left - pad * cellE, east1 = lake.right + pad * cellE;
  const outer = new THREE.Shape();
  outer.moveTo(-9000, -9000); outer.lineTo(9000, -9000); outer.lineTo(9000, 9000); outer.lineTo(-9000, 9000);
  const hole = new THREE.Path();
  hole.moveTo(east0, north1); hole.lineTo(east0, north0); hole.lineTo(east1, north0); hole.lineTo(east1, north1);
  outer.holes.push(hole);
  const country = new THREE.Mesh(new THREE.ShapeGeometry(outer),
                                 new THREE.MeshLambertMaterial({ color: WOODS.clone().lerp(MEADOW, 0.35) }));
  country.rotation.x = -Math.PI / 2;            // shape x = east, shape y = north
  country.position.y = EDGE_Y;

  const group = new THREE.Group();
  group.add(ground, country, makeTrees({ R, C, pad, cellN, cellE, lake, water, dist, heights }));
  return { group };
}

/* Conifers and broadleaf trees on the land, thick in the woods, thin in the
   meadows, none on the shore itself. */
function makeTrees({ R, C, pad, cellN, cellE, lake, water, dist, heights }) {
  const random = rng(42);
  const conifer = new THREE.LatheGeometry([
    [0, 0], [0.06, 0], [0.06, 0.16], [0.36, 0.18], [0.13, 0.43], [0.29, 0.43], [0.1, 0.67], [0.21, 0.67], [0, 1],
  ].map(([x, y]) => new THREE.Vector2(x, y)), 6);
  const broadleaf = new THREE.LatheGeometry([
    [0, 0], [0.05, 0], [0.05, 0.3], [0.3, 0.36], [0.45, 0.58], [0.36, 0.84], [0.14, 0.98], [0, 1],
  ].map(([x, y]) => new THREE.Vector2(x, y)), 6);
  for (const geometry of [conifer, broadleaf]) {
    const position = geometry.attributes.position;
    const shade = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const trunk = position.getY(i) < 0.17 && Math.hypot(position.getX(i), position.getZ(i)) < 0.07;
      shade.set(trunk ? [0.55, 0.42, 0.34] : [1, 1, 1], i * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(shade, 3));
  }
  const spots = { conifer: [], broadleaf: [] };
  for (let r = 1; r < R - 1; r++) {
    for (let c = 1; c < C - 1; c++) {
      const i = r * C + c;
      if (water[i] || dist[i] < 12 || dist[i] > 340) continue;
      const north = lake.top - (r - pad) * cellN, east = lake.left + (c - pad) * cellE;
      const wood = smooth(0.38, 0.6, fbm(east / 150 + 31, north / 150 - 9));
      if (random() > 0.035 + 0.3 * wood) continue;
      const kind = random() < 0.64 ? "conifer" : "broadleaf";
      spots[kind].push([east + (random() - 0.5) * cellE, heights[i] - 0.3, -(north + (random() - 0.5) * cellN), random()]);
    }
  }
  const group = new THREE.Group();
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  const position = new THREE.Vector3(), colour = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  for (const [kind, geometry, tall, hue] of [["conifer", conifer, [9, 18], [0.3, 0.36]],
                                            ["broadleaf", broadleaf, [7, 13], [0.2, 0.28]]]) {
    const list = spots[kind];
    for (let i = list.length - 1; i > 0; i--) {             // shuffle, so a cap thins evenly
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    list.length = Math.min(list.length, 2400);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(list.length, 1));
    mesh.count = list.length;
    list.forEach(([x, y, z, seed], n) => {
      const h = tall[0] + (tall[1] - tall[0]) * seed;
      quaternion.setFromAxisAngle(up, seed * 40);
      position.set(x, y, z);
      scale.set(h * (0.85 + 0.3 * random()), h, h * (0.85 + 0.3 * random()));
      mesh.setMatrixAt(n, matrix.compose(position, quaternion, scale));
      mesh.setColorAt(n, colour.setHSL(hue[0] + (hue[1] - hue[0]) * random(), 0.32 + 0.14 * random(),
                                        (kind === "conifer" ? 0.15 : 0.21) + 0.07 * random()));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  return group;
}

/* ----- wind on the water -------------------------------------------------- */

/* Short streaks that drift downwind across the water around the boat, faded
   at their tails and toward the edge of the patch they wrap within. */
export function makeWindStreaks(count = 160, half = 75) {
  const positions = new Float32Array(count * 6);
  const colors = new Float32Array(count * 8);
  const random = rng(3);
  const streaks = Array.from({ length: count }, () => ({
    x: (random() * 2 - 1) * half, z: (random() * 2 - 1) * half, length: 1.6 + random() * 3.4, a: 0.4 + random() * 0.6,
  }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 2;
  let colour = new THREE.Color(0xffffff), opacity = 0.3;
  return {
    lines,
    recolor(p) { colour = new THREE.Color(p.streak); opacity = p.streakOpacity; },
    update(dt, centre, windFromDeg, speed) {
      const to = deg(windFromDeg + 180);
      const ux = Math.sin(to), uz = -Math.cos(to);
      const strength = Math.min(speed / 5, 1) * opacity;
      streaks.forEach((s, i) => {
        s.x += ux * speed * dt; s.z += uz * speed * dt;
        let rx = s.x - centre.x, rz = s.z - centre.z;
        if (rx > half) s.x -= 2 * half; else if (rx < -half) s.x += 2 * half;
        if (rz > half) s.z -= 2 * half; else if (rz < -half) s.z += 2 * half;
        rx = s.x - centre.x; rz = s.z - centre.z;
        const edge = 1 - smooth(half * 0.55, half, Math.max(Math.abs(rx), Math.abs(rz)));
        const j = i * 6;
        positions[j] = s.x; positions[j + 1] = 0.05; positions[j + 2] = s.z;
        positions[j + 3] = s.x + ux * s.length; positions[j + 4] = 0.05; positions[j + 5] = s.z + uz * s.length;
        colors.set([colour.r, colour.g, colour.b, 0, colour.r, colour.g, colour.b, s.a * strength * edge], i * 8);
      });
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    },
    recentre(centre) {
      for (const s of streaks) {
        s.x = centre.x + (random() * 2 - 1) * half;
        s.z = centre.z + (random() * 2 - 1) * half;
      }
    },
  };
}

/* ----- track, wake and course --------------------------------------------- */

/* The boat's track: where it has really been. Points are appended to a
   growing buffer, so a long run never rebuilds the whole line. */
export function makeTrack() {
  const material = new LineMaterial({ linewidth: 2, transparent: true, opacity: 0.75, depthWrite: false });
  let capacity = 0, count = 0, segments = null, geometry = null, line = null, last = null;
  const group = new THREE.Group();
  const allocate = (wanted) => {
    capacity = Math.max(1024, 2 ** Math.ceil(Math.log2(wanted)));
    const next = new Float32Array(capacity * 6);
    if (segments) next.set(segments.subarray(0, count * 6));
    segments = next;
    if (line) { group.remove(line); geometry.dispose(); }
    geometry = new LineSegmentsGeometry();
    geometry.setPositions(segments);
    geometry.instanceCount = count;
    line = new LineSegments2(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 3;
    group.add(line);
  };
  allocate(1024);
  const push = (p) => {
    if (last) {
      if (count + 1 > capacity) allocate(count + 1);
      segments.set([last.x, last.y, last.z, p.x, p.y, p.z], count * 6);
      count += 1;
      geometry.instanceCount = count;
      const buffer = geometry.attributes.instanceStart.data;
      buffer.addUpdateRange?.((count - 1) * 6, 6);
      buffer.needsUpdate = true;
    }
    last = p;
  };
  return {
    group, material,
    recolor(p) { material.color.set(p.track); },
    set(northEast) {
      count = 0;
      last = null;
      if (northEast.length + 1 > capacity) allocate(northEast.length + 1);
      for (const [n, e] of northEast) {
        const p = toWorld(n, e, TRACK_Y);
        if (last) segments.set([last.x, last.y, last.z, p.x, p.y, p.z], count++ * 6);
        last = p;
      }
      geometry.instanceCount = count;
      const buffer = geometry.attributes.instanceStart.data;
      buffer.clearUpdateRanges?.();
      buffer.needsUpdate = true;
    },
    add(north, east) {
      const p = toWorld(north, east, TRACK_Y);
      if (!last || last.distanceTo(p) >= 1) push(p);
    },
  };
}

/* Foam behind the boat: a ribbon from the transom that widens and fades over
   the last ~30 m, brightest along its edges where the wake's arms run, its
   texture fixed to the water so the foam stays where it was made. */
export function makeWake(segments = 64) {
  const positions = new Float32Array(segments * 2 * 3);
  const uvs = new Float32Array(segments * 2 * 2);
  const index = [];
  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  for (let i = 0; i < segments; i++) uvs.set([0, i / (segments - 1), 1, i / (segments - 1)], i * 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      color: { value: new THREE.Color(0xffffff) }, strength: { value: 0 }, trailLength: { value: 0 },
    }]),
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec2 vUv; varying vec2 vWorld;
      void main() {
        vUv = uv; vWorld = position.xz;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform vec3 color; uniform float strength; uniform float trailLength;
      varying vec2 vUv; varying vec2 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        float across = abs(vUv.x - 0.5) * 2.0;
        float along = clamp(vUv.y / max(trailLength, 0.001), 0.0, 1.0);
        float arms = smoothstep(0.5, 0.86, across) * (1.0 - smoothstep(0.9, 1.0, across));
        float churn = (1.0 - smoothstep(0.0, 0.5, across)) * (1.0 - smoothstep(0.0, 0.45, along));
        float grain = noise(vWorld * 2.6) * 0.6 + noise(vWorld * 7.0) * 0.4;
        float foam = (arms * 0.8 + churn) * smoothstep(0.3, 0.8, grain + 0.2 * (1.0 - along));
        gl_FragColor = vec4(color, foam * strength * pow(1.0 - along, 2.0));
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  const trail = [];          // recent stern positions, newest first
  return {
    mesh,
    recolor(p) { material.uniforms.color.value.set(p.foam); },
    reset() { trail.length = 0; material.uniforms.strength.value = 0; },
    /* stern: the transom's world position; speed in m/s fades the foam at rest. */
    update(stern, speed) {
      const last = trail[0];
      if (!last || last.distanceTo(stern) > 0.45) {
        trail.unshift(stern.clone());
        trail.length = Math.min(trail.length, segments);
      } else {
        trail[0].copy(stern);
      }
      material.uniforms.strength.value = Math.min(speed / 1.4, 1) * 0.5;
      material.uniforms.trailLength.value = Math.max(trail.length - 1, 1) / (segments - 1);
      for (let i = 0; i < segments; i++) {
        const p = trail[Math.min(i, trail.length - 1)] || stern;
        const q = trail[Math.min(i + 1, trail.length - 1)] || p;
        const o = trail[Math.max(i - 1, 0)] || p;
        let dx = o.x - q.x, dz = o.z - q.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const half = 0.14 + i * 0.034;
        positions.set([p.x - dz * half, 0.03, p.z + dx * half, p.x + dz * half, 0.03, p.z - dx * half], i * 6);
      }
      geometry.attributes.position.needsUpdate = true;
    },
  };
}

/* A racing mark: a float with a cone on top. */
const BUOY = new THREE.LatheGeometry([
  [0, -0.35], [0.36, -0.35], [0.42, -0.1], [0.42, 0.55], [0.36, 0.62], [0.06, 1.15], [0.0, 1.17],
].map(([x, y]) => new THREE.Vector2(x, y)), 28);

/* The planned course: a dashed line through numbered marks, in the accent. */
export function makeCourse() {
  const group = new THREE.Group();
  const routeMaterial = new LineMaterial({ linewidth: 1.6, dashed: true, dashSize: 5, gapSize: 4,
                                           transparent: true, depthWrite: false });
  const nextMaterial = new THREE.MeshStandardMaterial({ roughness: 0.45 });
  const idleMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55 });
  const doneMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, color: 0x80878a });
  let buoys = [];
  return {
    group, material: routeMaterial,
    recolor(p) { routeMaterial.color.set(p.accent); nextMaterial.color.set(p.accent); idleMaterial.color.set(p.idle); },
    /* waypoints: [{north, east}], sailed in order from the start. */
    set(waypoints) {
      for (const { buoy, label } of buoys) buoy.remove(label);   // takes the number tags off the page
      group.clear();
      buoys = [];
      if (!waypoints.length) return;
      const route = [toWorld(0, 0, TRACK_Y + 0.02), ...waypoints.map((w) => toWorld(w.north, w.east, TRACK_Y + 0.02))];
      const geometry = new LineGeometry();
      geometry.setPositions(route.flatMap((p) => [p.x, p.y, p.z]));
      const routeLine = new Line2(geometry, routeMaterial);
      routeLine.computeLineDistances();
      routeLine.frustumCulled = false;
      routeLine.renderOrder = 3;
      group.add(routeLine);
      buoys = waypoints.map((w, i) => {
        const buoy = new THREE.Mesh(BUOY, idleMaterial);
        buoy.scale.setScalar(0.62);          // a small racing mark, about 70 cm tall
        buoy.position.copy(toWorld(w.north, w.east, 0));
        buoy.castShadow = true;
        buoy.userData.phase = i * 1.7;
        const tag = document.createElement("div");
        tag.className = "tag3d";
        tag.textContent = String(i + 1);
        const label = new CSS2DObject(tag);
        label.position.set(0, 2.6, 0);
        buoy.add(label);
        group.add(buoy);
        return { buoy, tag, label };
      });
    },
    progress(index, reached) {
      buoys.forEach(({ buoy, tag }, i) => {
        const next = i === index && reached < buoys.length;
        buoy.material = next ? nextMaterial : i < reached ? doneMaterial : idleMaterial;
        tag.className = "tag3d" + (next ? " next" : i < reached ? " done" : "");
      });
    },
    /* The marks ride the ripples. */
    bob(time) {
      for (const { buoy } of buoys) {
        const t = time + buoy.userData.phase;
        buoy.position.y = Math.sin(t * 1.3) * 0.035;
        buoy.rotation.set(Math.sin(t * 0.9) * 0.05, 0, Math.cos(t * 1.1) * 0.05);
      }
    },
  };
}
