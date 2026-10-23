/*
 * Everything around the boat: sky, water, the lake and its bed, the wind on
 * the water, the boat's track and wake, and the planned course.
 *
 * World frame: metres, x east, y up, z south (so north is -z). Positions from
 * the simulator are north/east of the scenario origin; toWorld() converts.
 */
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const toWorld = (north, east, y = 0) => new THREE.Vector3(east, y, -north);

const LAND_Y = 0.6;
const TRACK_Y = 0.1;             // above the ripples, so lines don't flicker into the water
const DEEPEST_M = 6.5;

/* Scene colours per theme, matched to the page's tokens. Light is a bright
   overcast day on the lake; dark is dusk. */
export const PALETTES = {
  light: {
    skyTop: 0xb7c9d0, skyHorizon: 0xeef2f1, fog: 0xe6ecec,
    hemiSky: 0xf5f8f8, hemiGround: 0x8d988f, hemi: 0.6, sun: 0xfff4e6, sunI: 2.1,
    water: 0x3f7383, waterOpacity: 0.8, shallow: 0xcdbf98, deep: 0x1d4d59, land: 0xc9cfc2,
    streak: 0x1b2427, streakOpacity: 0.16, track: 0x121615, foam: 0xffffff, idle: 0x8a9291,
    hull: 0x2b3134, deck: 0xeeece5, wing: 0xf6f6f2, foil: 0x343a3c, trim: 0x121615,
    accent: 0x1b6c80, caution: 0xa86f0c, text: 0x121615, muted: 0x565d5c,
  },
  dark: {
    skyTop: 0x0c1014, skyHorizon: 0x3b454c, fog: 0x1b2025,
    hemiSky: 0x5d6a75, hemiGround: 0x121517, hemi: 1.0, sun: 0xd8e1e8, sunI: 1.9,
    water: 0x123139, waterOpacity: 0.84, shallow: 0x4b4636, deep: 0x06141a, land: 0x1a1e1d,
    streak: 0xffffff, streakOpacity: 0.14, track: 0xf1f4f3, foam: 0xdfe8ea, idle: 0x7d8786,
    hull: 0xe3e3de, deck: 0x9c9a93, wing: 0xe8e9e5, foil: 0x2b2f31, trim: 0x0a0c0c,
    accent: 0x5cb8cc, caution: 0xe0a73a, text: 0xf1f4f3, muted: 0xb0b8b6,
  },
};

/* ----- sky ---------------------------------------------------------------- */

function gradientSphere(radius, top, horizon) {
  const geometry = new THREE.SphereGeometry(radius, 48, 24);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const t = new THREE.Color(top), h = new THREE.Color(horizon), c = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    c.copy(h).lerp(t, Math.pow(Math.max(position.getY(i) / radius, 0), 0.55));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function makeSky() {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const mesh = new THREE.Mesh(gradientSphere(4000, 0, 0), material);
  mesh.renderOrder = -1;
  return {
    mesh,
    recolor(p) {
      mesh.geometry.dispose();
      mesh.geometry = gradientSphere(4000, p.skyTop, p.skyHorizon);
    },
  };
}

/* The same sky, blurred, for reflections on the water and the hull. */
export function skyEnvironment(renderer, p) {
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(gradientSphere(10, p.skyTop, p.skyHorizon),
                          new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(room, 0.02).texture;
  pmrem.dispose();
  return texture;
}

/* ----- water -------------------------------------------------------------- */

/* A tileable normal map, drawn once on a canvas from a sum of waves. */
function rippleTexture(waves, strength) {
  const n = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(n, n);
  const k = (2 * Math.PI) / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let dx = 0, dy = 0;
      for (const [kx, ky, a, phase] of waves) {
        const c = Math.cos(k * (kx * x + ky * y) + phase) * a * k * strength;
        dx += c * kx; dy += c * ky;
      }
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      image.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      image.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      image.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

const SWELL_TILE_M = 11, CHOP_TILE_M = 4.5;

export function makeWater(transparent) {
  const size = 6000;
  const swell = rippleTexture([[1, 2, 0.9, 0.3], [3, 1, 0.55, 1.7], [-2, 3, 0.4, 2.2], [5, -2, 0.25, 0.4],
                               [-4, -5, 0.18, 1.1], [7, 3, 0.12, 2.9], [-9, 4, 0.08, 0.8]], 18);
  const chop = rippleTexture([[3, 5, 0.5, 0.9], [-5, 2, 0.45, 2.1], [7, -4, 0.3, 1.4], [-6, -7, 0.25, 0.2],
                              [9, 4, 0.18, 2.7], [-11, 6, 0.12, 1.9], [2, -12, 0.1, 0.6]], 9);
  swell.repeat.set(size / SWELL_TILE_M, size / SWELL_TILE_M);
  chop.repeat.set(size / CHOP_TILE_M, size / CHOP_TILE_M);
  const material = new THREE.MeshPhysicalMaterial({
    roughness: 0.3, metalness: 0, normalMap: swell, normalScale: new THREE.Vector2(0.12, 0.12),
    clearcoat: 0.35, clearcoatRoughness: 0.18, clearcoatNormalMap: chop,
    clearcoatNormalScale: new THREE.Vector2(0.08, 0.08), transparent,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return {
    mesh,
    /* Ripples drift downwind; the chop faster than the swell. */
    drift(dt, windFromDeg, speed) {
      const to = THREE.MathUtils.degToRad(windFromDeg + 180);
      const ex = Math.sin(to) * speed * dt, ny = Math.cos(to) * speed * dt;
      swell.offset.x += (ex * 0.15) / SWELL_TILE_M; swell.offset.y += (ny * 0.15) / SWELL_TILE_M;
      chop.offset.x += (ex * 0.35) / CHOP_TILE_M; chop.offset.y += (ny * 0.35) / CHOP_TILE_M;
    },
    /* Seen from high above, the ripples would tile into a visible pattern. */
    detail(scale) {
      material.normalScale.set(scale * 0.12, scale * 0.12);
      material.clearcoatNormalScale.set(scale * 0.08, scale * 0.08);
    },
    recolor(p) { material.color.set(p.water); material.opacity = transparent ? p.waterOpacity : 1; },
  };
}

/* ----- the lake ----------------------------------------------------------- */

/* The lake bed from the depth grid (corners in north/east metres: top, bottom,
   left, right), with land at the shore and around the lake. */
export function makeLake(lake) {
  const { rows, cols, depth } = lake;
  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    const north = lake.top + (lake.bottom - lake.top) * (r / (rows - 1));
    for (let c = 0; c < cols; c++) {
      const east = lake.left + (lake.right - lake.left) * (c / (cols - 1));
      const d = depth[r * cols + c];
      const i = (r * cols + c) * 3;
      positions[i] = east;
      positions[i + 1] = d === null ? LAND_Y : -Math.max(d, 0.15);
      positions[i + 2] = -north;
    }
  }
  const index = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + cols;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const bed = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));

  // Land beyond the grid: a large plane with the lake's rectangle cut out.
  const outer = new THREE.Shape();
  outer.moveTo(-4000, -4000); outer.lineTo(4000, -4000); outer.lineTo(4000, 4000); outer.lineTo(-4000, 4000);
  const hole = new THREE.Path();
  hole.moveTo(lake.left, lake.bottom); hole.lineTo(lake.left, lake.top);
  hole.lineTo(lake.right, lake.top); hole.lineTo(lake.right, lake.bottom);
  outer.holes.push(hole);
  const landMaterial = new THREE.MeshLambertMaterial();
  const land = new THREE.Mesh(new THREE.ShapeGeometry(outer), landMaterial);
  land.rotation.x = -Math.PI / 2;            // shape x = east, shape y = north
  land.position.y = LAND_Y - 0.05;

  const group = new THREE.Group();
  group.add(bed, land);
  const shallow = new THREE.Color(), deep = new THREE.Color(), landColor = new THREE.Color(), tmp = new THREE.Color();
  return {
    group,
    recolor(p) {
      shallow.set(p.shallow); deep.set(p.deep); landColor.set(p.land);
      for (let k = 0; k < depth.length; k++) {
        const d = depth[k];
        if (d === null) tmp.copy(landColor);
        else tmp.copy(shallow).lerp(deep, Math.pow(Math.min(d / DEEPEST_M, 1), 0.7));
        colors[k * 3] = tmp.r; colors[k * 3 + 1] = tmp.g; colors[k * 3 + 2] = tmp.b;
      }
      geometry.attributes.color.needsUpdate = true;
      landMaterial.color.copy(landColor);
    },
  };
}

/* ----- wind on the water -------------------------------------------------- */

/* Short streaks that drift downwind across the water around the boat. */
export function makeWindStreaks(count = 120, half = 70) {
  const positions = new Float32Array(count * 6);
  const streaks = Array.from({ length: count }, () => ({
    x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half, length: 2 + Math.random() * 4,
  }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  return {
    lines,
    recolor(p) { material.color.set(p.streak); material.opacity = p.streakOpacity; },
    update(dt, centre, windFromDeg, speed) {
      const to = THREE.MathUtils.degToRad(windFromDeg + 180);
      const ux = Math.sin(to), uz = -Math.cos(to);
      streaks.forEach((s, i) => {
        s.x += ux * speed * dt; s.z += uz * speed * dt;
        const rx = s.x - centre.x, rz = s.z - centre.z;
        if (rx > half) s.x -= 2 * half; else if (rx < -half) s.x += 2 * half;
        if (rz > half) s.z -= 2 * half; else if (rz < -half) s.z += 2 * half;
        const j = i * 6;
        positions[j] = s.x; positions[j + 1] = 0.04; positions[j + 2] = s.z;
        positions[j + 3] = s.x + ux * s.length; positions[j + 4] = 0.04; positions[j + 5] = s.z + uz * s.length;
      });
      geometry.attributes.position.needsUpdate = true;
    },
    recentre(centre) {
      for (const s of streaks) {
        s.x = centre.x + (Math.random() * 2 - 1) * half;
        s.z = centre.z + (Math.random() * 2 - 1) * half;
      }
    },
  };
}

/* ----- track, wake and course --------------------------------------------- */

function fatLine(points, material) {
  const geometry = new LineGeometry();
  geometry.setPositions(points.length >= 2 ? points.flatMap((p) => [p.x, p.y, p.z]) : [0, -50, 0, 0, -50, 0]);
  const line = new Line2(geometry, material);
  line.frustumCulled = false;
  return line;
}

/* The boat's track: where it has really been. */
export function makeTrack() {
  const material = new LineMaterial({ linewidth: 2, transparent: true, opacity: 0.7, depthWrite: false });
  const points = [];
  const group = new THREE.Group();
  let line = fatLine(points, material);
  group.add(line);
  const redraw = () => {
    group.remove(line);
    line.geometry.dispose();
    line = fatLine(points, material);
    group.add(line);
  };
  return {
    group, material,
    recolor(p) { material.color.set(p.track); },
    set(northEast) {
      points.length = 0;
      for (const [n, e] of northEast) points.push(toWorld(n, e, TRACK_Y));
      redraw();
    },
    add(north, east) {
      const p = toWorld(north, east, TRACK_Y);
      const last = points[points.length - 1];
      if (!last || last.distanceTo(p) >= 1) { points.push(p); redraw(); }
    },
  };
}

/* Foam behind the boat: a ribbon that widens and fades over the last ~25 m. */
export function makeWake(segments = 48) {
  const positions = new Float32Array(segments * 2 * 3);
  const alphas = new Float32Array(segments * 2);
  const index = [];
  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));
  geometry.setIndex(index);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { color: { value: new THREE.Color(0xffffff) } },
    vertexShader: "attribute float alpha; varying float vAlpha; void main() { vAlpha = alpha; " +
                  "gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform vec3 color; varying float vAlpha; void main() { gl_FragColor = vec4(color, vAlpha); }",
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const trail = [];          // recent stern positions, newest first
  return {
    mesh,
    recolor(p) { material.uniforms.color.value.set(p.foam); },
    reset() { trail.length = 0; alphas.fill(0); geometry.attributes.alpha.needsUpdate = true; },
    /* stern: the transom's world position; speed in m/s fades the foam at rest. */
    update(stern, speed) {
      const last = trail[0];
      if (!last || last.distanceTo(stern) > 0.5) {
        trail.unshift(stern.clone());
        trail.length = Math.min(trail.length, segments);
      } else {
        trail[0].copy(stern);
      }
      const strength = Math.min(speed / 1.2, 1) * 0.55;
      for (let i = 0; i < segments; i++) {
        const p = trail[Math.min(i, trail.length - 1)] || stern;
        const q = trail[Math.min(i + 1, trail.length - 1)] || p;
        let dx = p.x - q.x, dz = p.z - q.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const half = 0.12 + i * 0.045;
        positions.set([p.x - dz * half, 0.06, p.z + dx * half, p.x + dz * half, 0.06, p.z - dx * half], i * 6);
        const fade = i < trail.length ? strength * (1 - i / segments) ** 1.6 : 0;
        alphas[i * 2] = alphas[i * 2 + 1] = fade;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.alpha.needsUpdate = true;
    },
  };
}

/* The planned course: a dashed line through numbered buoys, in the accent. */
export function makeCourse() {
  const group = new THREE.Group();
  const routeMaterial = new LineMaterial({ linewidth: 1.5, dashed: true, dashSize: 5, gapSize: 4,
                                           transparent: true, depthWrite: false });
  const buoyGeometry = new THREE.CylinderGeometry(0.32, 0.42, 1.3, 24);
  const nextMaterial = new THREE.MeshStandardMaterial({ roughness: 0.5 });
  const idleMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  let buoys = [];
  let routeLine = null;
  return {
    group, material: routeMaterial,
    recolor(p) { routeMaterial.color.set(p.accent); nextMaterial.color.set(p.accent); idleMaterial.color.set(p.idle); },
    /* waypoints: [{north, east}], sailed in order from the start. */
    set(waypoints) {
      group.clear();
      buoys = [];
      if (!waypoints.length) return;
      const route = [toWorld(0, 0, TRACK_Y + 0.02), ...waypoints.map((w) => toWorld(w.north, w.east, TRACK_Y + 0.02))];
      routeLine = fatLine(route, routeMaterial);
      routeLine.computeLineDistances();
      group.add(routeLine);
      buoys = waypoints.map((w, i) => {
        const buoy = new THREE.Mesh(buoyGeometry, idleMaterial);
        buoy.position.copy(toWorld(w.north, w.east, 0.45));
        buoy.castShadow = true;
        const tag = document.createElement("div");
        tag.className = "tag3d";
        tag.textContent = String(i + 1);
        const label = new CSS2DObject(tag);
        label.position.set(0, 1.9, 0);
        buoy.add(label);
        group.add(buoy);
        return { buoy, tag };
      });
    },
    progress(index, reached) {
      buoys.forEach(({ buoy, tag }, i) => {
        const next = i === index && reached < buoys.length;
        buoy.material = next ? nextMaterial : idleMaterial;
        tag.className = "tag3d" + (next ? " next" : i < reached ? " done" : "");
      });
    },
  };
}
