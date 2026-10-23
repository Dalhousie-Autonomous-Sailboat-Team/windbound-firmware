/* Number and text formats shared by every section. */
const MINUS = "−";

export const KNOTS = 1.943844;

/* +12.5 / −3.0 / 0.0 */
export const signed = (v, digits = 1) => (v < 0 ? MINUS : v > 0 ? "+" : "") + Math.abs(v).toFixed(digits);

/* Seconds as m:ss or h:mm:ss. */
export const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
};

/* A compass bearing, always three digits: 007. */
export const bearing = (deg) => String(Math.round(((deg % 360) + 360) % 360) % 360).padStart(3, "0");

/* An age in seconds, short: 0.4 s, 12 s, 3:05. */
export const age = (seconds) =>
  seconds < 10 ? `${seconds.toFixed(1)} s` : seconds < 60 ? `${Math.round(seconds)} s` : clock(seconds);

export const wrap180 = (deg) => ((deg + 180) % 360 + 360) % 360 - 180;

/* Where the wind is relative to the bow: "38° to port". */
export const windSide = (awa) => Math.abs(awa) < 0.5 ? "dead ahead"
  : `${Math.abs(awa).toFixed(0)}° ${awa > 0 ? "to starboard" : "to port"}`;

/* The point of sail for an apparent wind angle (positive from starboard). */
export function pointOfSail(awa) {
  const a = Math.abs(wrap180(awa));
  const tack = awa >= 0 ? "Starboard tack" : "Port tack";
  const name = a < 30 ? "in irons" : a < 55 ? "close-hauled" : a < 80 ? "close reach"
    : a < 110 ? "beam reach" : a < 150 ? "broad reach" : "running";
  return a < 30 ? "Head to wind, in irons" : `${tack}, ${name}`;
}

export const SOURCE_NAMES = { xbee: "Joystick", rpi: "Autopilot", none: "Nobody" };

export const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

export const latlon = (lat, lon) =>
  `${lat.toFixed(6)}, ${lon < 0 ? MINUS : ""}${Math.abs(lon).toFixed(6)}`;

/* Distance in metres between two lat/lon points (equirectangular, fine on a lake). */
export function distance(a, b) {
  const k = Math.PI / 180, r = 6371000;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * r;
}

export const timeOfDay = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
