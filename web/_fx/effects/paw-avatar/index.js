/*!
 * paw-avatar — a mascot head whose pose is a pure function of time.
 *
 * Engine ported from bloub, MIT License, Copyright (c) 2026 Jérémy Perret.
 * https://github.com/jeremy-prt/bloub @ b4bb3c1
 *
 * Ported from upstream: src/bot/math.ts whole (easings, loopNoise, mulberry32,
 * r2), src/bot/shape.ts (unionOfCirclesProfile, toPoints, closedPath,
 * capsulePath, radiusAtAngle), src/bot/face.ts (the sphere eye frame, the
 * pre-drawn blink schedule, liveliness, blinkScale), src/bot/engine.ts (the
 * clock-free sample(t), the dated setState and its frozen-departure pose).
 *
 * NOT ported, and not copyable: upstream's PROFILES arrays and its 14 states
 * are measurements of the x.ai bot. The Paw head, its ear rig and all 15
 * states here are ours, authored as circle sets rather than traced radii.
 */

/* ------------------------------------------------------------------ math */
/* Ported verbatim in behaviour from bloub src/bot/math.ts. */

const TAU = Math.PI * 2;
const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const r2 = (v) => Math.round(v * 100) / 100;

const easeOutQuint = (t) => 1 - (1 - t) ** 5;

/** 1D periodic noise: loops seamlessly on `period`. Used for gaze drift. */
function loopNoise(t, period, seed = 0) {
  const p = (t / period) * TAU;
  return (
    0.55 * Math.sin(p + seed) +
    0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
    0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
  );
}

/** mulberry32: the same sequence on every read, so the blink calendar is fixed. */
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ear settle: one damped overshoot, normalised so f(0) = 0 and f(1) = 1.
 *
 * Ours, and the one place the Paw disagrees with upstream on purpose. Bloub
 * measured its bot and found NO overshoot on the body -- correct for a
 * floating blob, wrong for something with ears. Ears have mass: they leave
 * late, swing past, and settle. Without this every state change moved the
 * head and the ears in the same instant, which is what made the character
 * read as rigid however good the silhouette was.
 *
 * Exactly 1 at the end matters: the engine drops back to the raw pose once
 * the morph window closes, so anything short of 1 would snap.
 */
const EAR_SETTLE_NORM = 1 / (1 - Math.exp(-5) * Math.cos(7));
const earSettle = (k) => (1 - Math.exp(-5 * k) * Math.cos(7 * k)) * EAR_SETTLE_NORM;

/** How far behind the head the ears start, as a fraction of the state's morph. */
const EAR_LAG = 0.25;

/* --------------------------------------------------------------- frame of
 * reference. RADIUS is the head radius in viewBox units and every number
 * below is a fraction of it. HALF_BOX is not free: a raised ear reaches
 * ~1.79 head radii and the glyphs sit outside the head too. Nothing bounds
 * either at runtime -- it is the hand-set ear swings in STATES that keep the
 * geometry inside, and tests/paw-avatar.test.js locks that down. */
const RADIUS = 100;
/**
 * The smallest half-viewBox any mascot gets. The glyphs are the engine's,
 * not the drawing's, and the furthest of them sits here; a drawing whose
 * ears reach past it widens the box instead (see `box` in compileArt).
 */
const GLYPH_REACH = 162;

/** Angular samples of the silhouette. A thin ear tip needs more than 64. */
const SAMPLES = 96;
const ANGLES = Array.from({ length: SAMPLES }, (_, i) => (i / SAMPLES) * TAU);
const COS = ANGLES.map(Math.cos);
const SIN = ANGLES.map(Math.sin);

/* ----------------------------------------------------------------- shape */

/**
 * Radial profile of a UNION of disks: r(theta) is the farthest ray/circle
 * intersection. Exact while the origin sits inside the union, which is what
 * lets a head and two ears be one closed outline with no path booleans.
 * Ported from bloub src/bot/shape.ts.
 */
function unionOfCirclesProfile(circles, out = new Array(SAMPLES)) {
  for (let i = 0; i < SAMPLES; i++) {
    const dx = COS[i];
    const dy = SIN[i];
    let best = 0;
    for (const c of circles) {
      const b = dx * c.x + dy * c.y;
      const disc = b * b - (c.x * c.x + c.y * c.y - c.r * c.r);
      if (disc < 0) continue;
      const t = b + Math.sqrt(disc);
      if (t > best) best = t;
    }
    out[i] = best;
  }
  return out;
}

/**
 * Polygon -> radial profile, by casting a ray from `center` at every sample
 * angle and keeping the farthest edge hit. Ported from bloub
 * src/bot/shape.ts, where it exists for the shapes that do not fall out of
 * r(theta) naturally. Here it is how the authored art becomes morphable:
 * once a drawn silhouette is a profile, it squashes, tilts and interpolates
 * exactly like a generated one. Computed once at load, never per frame.
 */
function profileFromPolygon(poly, cx, cy) {
  const radii = new Array(SAMPLES).fill(0);
  const n = poly.length;
  for (let k = 0; k < SAMPLES; k++) {
    const dx = COS[k];
    const dy = SIN[k];
    let best = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const px = a.x - cx;
      const py = a.y - cy;
      const t = (px * ey - py * ex) / den; // distance along the ray
      const u = (px * dy - py * dx) / den; // position along the edge
      if (t > best && u >= 0 && u <= 1) best = t;
    }
    radii[k] = best;
  }
  return radii;
}

/**
 * An `M x y C ... Z` path to a polygon. Ours: upstream traced video frames
 * and had no path to read. Only absolute M/C/Z, which is what the art file
 * uses; anything else would need more parser than this effect can justify.
 */
function flattenPath(d, steps = 24) {
  const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const pts = [];
  let i = 0;
  let x = n[i++];
  let y = n[i++];
  pts.push({ x, y });
  while (i + 6 <= n.length) {
    const x1 = n[i++], y1 = n[i++], x2 = n[i++], y2 = n[i++], x3 = n[i++], y3 = n[i++];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const v = 1 - t;
      pts.push({
        x: v * v * v * x + 3 * v * v * t * x1 + 3 * v * t * t * x2 + t * t * t * x3,
        y: v * v * v * y + 3 * v * v * t * y1 + 3 * v * t * t * y2 + t * t * t * y3
      });
    }
    x = x3;
    y = y3;
  }
  return pts;
}

/** Profile -> screen points. `scale` = head radius in viewBox units. */
function toPoints(radii, pose, scale, out = []) {
  const cr = Math.cos(pose.rot);
  const sr = Math.sin(pose.rot);
  for (let i = 0; i < SAMPLES; i++) {
    const r = radii[i];
    const x = r * COS[i];
    const y = r * SIN[i];
    const rx = x * cr - y * sr;
    const ry = x * sr + y * cr;
    const p = out[i] ?? { x: 0, y: 0 };
    p.x = (rx * pose.sx + pose.cx) * scale;
    p.y = (ry * pose.sy + pose.cy) * scale;
    out[i] = p;
  }
  out.length = SAMPLES;
  return out;
}

/**
 * Closed polyline -> Catmull-Rom cubics. At this sample count centred
 * tangents are smooth to the pixel and the `d` string stays short.
 * Ported from bloub src/bot/shape.ts.
 */
function closedPath(pts, tension = 1 / 6) {
  const n = pts.length;
  if (n < 3) return "";
  let d = `M${r2(pts[0].x)} ${r2(pts[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += `C${r2(p1.x + (p2.x - p0.x) * tension)} ${r2(p1.y + (p2.y - p0.y) * tension)}`;
    d += ` ${r2(p2.x - (p3.x - p1.x) * tension)} ${r2(p2.y - (p3.y - p1.y) * tension)}`;
    d += ` ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return `${d}Z`;
}

/**
 * The mouth, drawn from three numbers in a box the drawing gives.
 *
 * Generated rather than morphed between drawn shapes, for the same reason
 * the eyes are: a mouth is a curve and an opening, and two numbers express
 * that far better than a set of traced outlines could interpolate between.
 *
 * `curve` is +1 smile, -1 frown. It is the control point's Y, and in screen
 * coordinates a smile's middle sits LOWER than its corners, so positive is
 * down. `open` is how far the lower edge drops away from the upper one, with
 * a floor: at zero the two edges would coincide and a filled shape with no
 * area is nothing at all.
 */
function mouthPath(w, h, curve, open) {
  const hw = Math.max(w, 0.01) / 2;
  const lift = curve * h * 0.9;
  const depth = Math.max(h * 0.16, open * h);
  // As it opens, the top edge rises to meet the drop: a flat top over a deep
  // bottom is a D, and a D is a grin. Shock, a yell and a gasp are all an O,
  // and an O needs both edges to give.
  const top = lift - depth * 0.55 * open;
  return (
    `M${r2(-hw)} 0Q0 ${r2(top)} ${r2(hw)} 0` +
    `Q0 ${r2(lift + depth)} ${r2(-hw)} 0z`
  );
}

/** Capsule (stadium) centred on the origin: the eye shape. Ported from bloub. */
function capsulePath(w, h) {
  const hw = Math.max(w, 0.01) / 2;
  const hh = Math.max(h, 0.01) / 2;
  const r = Math.min(hw, hh);
  return (
    `M${r2(-hw)} ${r2(-hh + r)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw + r)} ${r2(-hh)}` +
    `L${r2(hw - r)} ${r2(-hh)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw)} ${r2(-hh + r)}` +
    `L${r2(hw)} ${r2(hh - r)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw - r)} ${r2(hh)}` +
    `L${r2(-hw + r)} ${r2(hh)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw)} ${r2(hh - r)}Z`
  );
}

/* ------------------------------------------------------------ the mascot
 *
 * The character is drawn, not generated, and the drawing is an INPUT. The
 * engine never learns what a Paw is: it is handed three silhouettes, two
 * pivots and an eye box, and everything after -- morphing, ears, gaze,
 * tracking -- is the same whatever the mascot. Hand `mount` a different art
 * object and you get a different character with the same sixteen states.
 *
 * The Paw's own description is PAW_ART, generated from
 * art/paw-os-glass-puppy.svg by `bun scripts/paw-art.mjs`. Its numbers are
 * in the drawing's own viewBox; everything downstream is in head
 * half-widths, the unit the rest of this file speaks.
 *
 * THE ONE CONSTRAINT. Each part is r(theta) about a single origin, so every
 * ray from that origin has to leave the outline exactly once. Blobs, domes
 * and lobe ears are fine. A tail, an antenna, or a notch deep enough for a
 * ray to cross twice gets quietly flattened -- which is why the CLI checks
 * for it and says so rather than letting it ship looking almost right.
 */
export const PAW_ART = {
  head: "M160 29 C119 28 84 46 68 78 C54 107 54 149 66 181 C76 208 107 225 160 226 C213 225 244 208 254 181 C266 149 266 107 252 78 C236 46 201 28 160 29Z",
  earL: "M76 74 C51 77 35 95 31 119 C27 141 35 161 51 168 C67 175 83 160 88 138 C93 116 95 91 88 80 C85 75 81 73 76 74Z",
  earR: "M244 74 C269 77 285 95 289 119 C293 141 285 161 269 168 C253 175 237 160 232 138 C227 116 225 91 232 80 C235 75 239 73 244 74Z",
  cx: 160,
  cy: 127.49,
  unit: 102.75,
  pivotL: { x: 76, y: 74 },
  pivotR: { x: 244, y: 74 },
  eye: { cx: 117.5, cy: 116.5, w: 25, h: 51 },
  catch: { dx: -4.5, dy: -13.5, r: 2.4 },
  glass: {
    fill: "<radialGradient id=\"FILL\" cx=\"0\" cy=\"0\" r=\"1\" gradientUnits=\"userSpaceOnUse\" gradientTransform=\"%M% translate(140 65) rotate(90) scale(205 205)\"><stop offset=\"0\" stop-color=\"var(--fx-paw-glass-0, #152033)\" stop-opacity=\"0.92\"/><stop offset=\"0.52\" stop-color=\"var(--fx-paw-glass-1, #0A0E17)\" stop-opacity=\"0.98\"/><stop offset=\"1\" stop-color=\"var(--fx-paw-glass-2, #02040A)\" stop-opacity=\"1\"/></radialGradient>",
    rim: "<linearGradient id=\"RIM\" x1=\"52\" y1=\"30\" x2=\"270\" y2=\"235\" gradientUnits=\"userSpaceOnUse\" gradientTransform=\"%M%\"><stop offset=\"0\" stop-color=\"var(--fx-paw-rim-a, #F8FCFF)\"/><stop offset=\"0.28\" stop-color=\"var(--fx-paw-rim-b, #D6E7FF)\"/><stop offset=\"0.62\" stop-color=\"var(--fx-paw-rim-c, #8CAFFF)\"/><stop offset=\"0.84\" stop-color=\"var(--fx-paw-rim-d, #A98CFF)\"/><stop offset=\"1\" stop-color=\"var(--fx-paw-rim-e, #83A2FF)\"/></linearGradient>",
    defs: "<radialGradient id=\"D0\" cx=\"0\" cy=\"0\" r=\"1\" gradientUnits=\"userSpaceOnUse\" gradientTransform=\"translate(160 224) rotate(90) scale(34 118)\"><stop offset=\"0\" stop-color=\"var(--fx-paw-floor-a, #AFC4FF)\" stop-opacity=\"0.36\"/><stop offset=\"0.40\" stop-color=\"var(--fx-paw-floor-b, #7E9FFF)\" stop-opacity=\"0.20\"/><stop offset=\"0.72\" stop-color=\"var(--fx-paw-floor-c, #7D62FF)\" stop-opacity=\"0.10\"/><stop offset=\"1\" stop-color=\"var(--fx-paw-floor-c, #7D62FF)\" stop-opacity=\"0\"/></radialGradient><linearGradient id=\"D1\" x1=\"73\" y1=\"40\" x2=\"180\" y2=\"132\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0\" stop-color=\"#FFFFFF\" stop-opacity=\"0.34\"/><stop offset=\"0.30\" stop-color=\"#DCEAFF\" stop-opacity=\"0.10\"/><stop offset=\"1\" stop-color=\"#FFFFFF\" stop-opacity=\"0\"/></linearGradient><filter id=\"D2\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\"><feGaussianBlur stdDeviation=\"10\"/></filter><filter id=\"D3\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\"><feGaussianBlur stdDeviation=\"5\"/></filter>",
    ground: "<ellipse cx=\"160\" cy=\"218\" rx=\"104\" ry=\"34\" fill=\"var(--fx-paw-halo, #6D8DFF)\" opacity=\"0.16\" filter=\"url(#D2)\"/><ellipse cx=\"160\" cy=\"226\" rx=\"92\" ry=\"17\" fill=\"url(#D0)\" filter=\"url(#D3)\"/><ellipse cx=\"160\" cy=\"226\" rx=\"69\" ry=\"7\" fill=\"var(--fx-paw-floor-a, #B7CAFF)\" opacity=\"0.22\" filter=\"url(#D3)\"/>",
    sheen: "<path d=\"M92 63 C111 41 135 34 160 35 C183 36 204 43 220 56 C202 54 181 55 159 60 C134 66 112 74 87 88 C87 78 89 69 92 63Z\" fill=\"url(#D1)\"/><path d=\"M63 96 C69 72 83 56 103 47\" stroke=\"var(--fx-paw-glint, #FFFFFF)\" stroke-width=\"3.8\" stroke-linecap=\"round\" opacity=\"0.33\"/><path d=\"M255 96 C249 72 237 57 219 48\" stroke=\"var(--fx-paw-glint, #FFFFFF)\" stroke-width=\"3.4\" stroke-linecap=\"round\" opacity=\"0.21\"/>"
  }
};

const centreOf = (pts) => ({
  x: (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2,
  y: (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2
});

/**
 * A drawing -> everything the engine needs from it. Ray-casting three
 * outlines is far too much to redo per frame, and two avatars on a page
 * usually share one drawing, so the result is memoised on the art object
 * itself rather than recomputed per mount.
 */
const compiled = new WeakMap();

export function compileArt(art) {
  const hit = compiled.get(art);
  if (hit) return hit;

  const toUnits = (px, py) => ({ x: (px - art.cx) / art.unit, y: (py - art.cy) / art.unit });
  const pathInUnits = (d) => flattenPath(d).map((p) => toUnits(p.x, p.y));

  // An ear is sampled about its own bbox centre, not its pivot: the pivot
  // sits ON the drawn outline, where half the rays would leave at radius
  // zero. The offset between the two is carried in `earPose` instead.
  const earOf = (d, pivotArt) => {
    const pts = pathInUnits(d);
    const pivot = toUnits(pivotArt.x, pivotArt.y);
    const origin = centreOf(pts);
    return {
      profile: profileFromPolygon(pts, origin.x, origin.y),
      pivot,
      arm: { x: origin.x - pivot.x, y: origin.y - pivot.y }
    };
  };

  // How far this drawing can reach, so the viewBox is sized for it rather
  // than for the Paw. The bound is taken over the swings the state table
  // actually asks for, not over every angle an ear could theoretically take:
  // assuming an ear might point straight out padded the Paw by a quarter of
  // its frame for a pose nothing ever strikes.
  const headPts = pathInUnits(art.head);
  const swing = earSwingRange();
  const span = (d, pivotArt) => {
    const pv = toUnits(pivotArt.x, pivotArt.y);
    const rel = pathInUnits(d).map((p) => ({ x: p.x - pv.x, y: p.y - pv.y }));
    let far = 0;
    for (let i = 0; i <= 12; i++) {
      const a = swing.lo + ((swing.hi - swing.lo) * i) / 12;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      for (const q of rel) {
        far = Math.max(far, Math.hypot(pv.x + (q.x * c - q.y * sn), pv.y - swing.lift + (q.x * sn + q.y * c)));
      }
    }
    return far;
  };
  const reach = Math.max(
    ...headPts.map((p) => Math.hypot(p.x, p.y)),
    span(art.earL, art.pivotL),
    span(art.earR, art.pivotR)
  );

  const eye = toUnits(art.eye.cx, art.eye.cy);
  const out = {
    /** Half the viewBox this drawing needs, glyphs included. */
    box: Math.max(GLYPH_REACH, Math.ceil(reach * RADIUS) + 8),
    art,
    head: profileFromPolygon(headPts, 0, 0),
    ear: { l: earOf(art.earL, art.pivotL), r: earOf(art.earR, art.pivotR) },
    eye: {
      w: art.eye.w / art.unit,
      h: art.eye.h / art.unit,
      /** Half-separation on the sphere the eyes ride, degrees. */
      split: (Math.asin(clamp(Math.abs(eye.x), 0, 1)) * 180) / Math.PI,
      /** How high the face sits on the head. */
      y: eye.y
    },
    /**
     * Where a mouth would go. Derived when the drawing has none, which is
     * the common case: most mascots are drawn at rest and at rest this one
     * has no mouth. Deriving it means a state can open one on any drawing.
     */
    mouth: art.mouth
      ? { x: toUnits(art.mouth.cx, art.mouth.cy).x, y: toUnits(art.mouth.cx, art.mouth.cy).y,
          w: art.mouth.w / art.unit, h: art.mouth.h / art.unit }
      : { x: 0, y: eye.y + (art.eye.h / art.unit) * 0.95,
          w: Math.abs(eye.x) * 1.45, h: (art.eye.h / art.unit) * 0.55 },
    catch: {
      x: (art.catch.dx / art.unit) * RADIUS,
      y: (art.catch.dy / art.unit) * RADIUS,
      r: (art.catch.r / art.unit) * RADIUS
    },
    /** Drawing coordinates -> this viewBox, for its gradients and decoration. */
    m: `scale(${r2(RADIUS / art.unit)}) translate(${-art.cx} ${-art.cy})`
  };
  compiled.set(art, out);
  return out;
}

/** Scratch buffers: nothing is reallocated per frame. */
function makeBody() {
  return { head: [], earL: [], earR: [] };
}

/**
 * Screen placement of one ear. `side` is -1 left, +1 right; a negative
 * `angle` swings the lobe outward on both sides, `lift` raises the root, and
 * the head's own tilt carries the whole ear around with it.
 *
 * Two rotations compose: the ear swings about its pivot, then the head tilt
 * turns that result about the head's centre.
 */
function earPose(side, ear, headRot, art) {
  const e = side < 0 ? art.ear.l : art.ear.r;
  const a = ear.angle * side;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // profile origin after the swing, still in head space
  const ox = e.pivot.x + (e.arm.x * ca - e.arm.y * sa);
  const oy = e.pivot.y - ear.lift + (e.arm.x * sa + e.arm.y * ca);
  const ch = Math.cos(headRot);
  const sh = Math.sin(headRot);
  return {
    rot: headRot + a,
    sx: 1,
    sy: 1,
    cx: ox * ch - oy * sh,
    cy: ox * sh + oy * ch
  };
}

/* ------------------------------------------------------------------ face
 * Ported from bloub src/bot/face.ts. The eyes live on a sphere, not flat on
 * the page: each one takes the tangent frame of the head at its own angle,
 * projected orthographically, so turning the gaze compresses and tilts them
 * on its own. That is where the volume comes from. */

const deg = (d) => (d * Math.PI) / 180;

/** The mascot looks at you: unlike bloub's 3/4 bot, rest gaze is square on. */
const REST_GAZE = { yaw: 0, pitch: -2, roll: 0 };

/** Rotate two vectors of an orthonormal frame within their common plane. */
function spin(u, v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s]
  ];
}

/** Head frame then both eye frames. Screen axes: x right, y down, z at you. */
function eyePoses(gaze, split) {
  let f = [0, 0, 1];
  let right = [1, 0, 0];
  let down = [0, 1, 0];
  [f, right] = spin(f, right, deg(gaze.yaw));
  [down, f] = spin(down, f, deg(gaze.pitch));
  [right, down] = spin(right, down, deg(gaze.roll));
  const build = (side) => {
    const [ef, er] = spin(f, right, deg(split * side));
    return { x: ef[0], y: ef[1], a: er[0], b: er[1], c: down[0], d: down[1], depth: ef[2] };
  };
  return [build(-1), build(1)];
}

const BLINK_RNG = createRng(0x5eed);
/** Pre-drawn blink calendar: deterministic and stateless. Ported from bloub. */
const BLINKS = (() => {
  const out = [];
  let t = 1.4;
  while (t < 900) {
    out.push(t);
    t += 1.9 + BLINK_RNG() * 2.7;
    if (BLINK_RNG() < 0.18) {
      out.push(t);
      t += 0.24;
    }
  }
  return out;
})();

const BLINK_DUR = 0.18;

function blinkLid(t) {
  for (let i = 0; i < BLINKS.length; i++) {
    const start = BLINKS[i];
    if (t < start) break;
    const k = (t - start) / BLINK_DUR;
    if (k >= 0 && k <= 1) return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
  }
  return 1;
}

/** A blink is a vertical squash on screen, not a shrink along the capsule axis. */
const blinkScale = (lid) => 0.06 + 0.94 * clamp(lid);

/**
 * Life at rest: slow gaze drift, blinks, breathing. A pure function of time,
 * so pausing, scrubbing and re-reading a past date all give the same image.
 * Periods are mutually prime so the drift never visibly repeats.
 */
function liveliness(t, wander = 1, blink = true) {
  return {
    dYaw: (loopNoise(t, 11.3, 0.4) * 5.5 + loopNoise(t, 3.7, 2.1) * 1.6) * wander,
    dPitch: (loopNoise(t, 9.1, 1.3) * 4.2 + loopNoise(t, 4.3, 0.7) * 1.3) * wander,
    dRoll: loopNoise(t, 13.7, 3.2) * 2.2 * wander,
    lid: blink ? blinkLid(t) : 1,
    driftX: loopNoise(t, 7.9, 1.9) * 0.008,
    driftY: loopNoise(t, 5.3, 0.3) * 0.009,
    breath: 1 + Math.sin((t / 3.4) * TAU) * 0.012
  };
}

/* ----------------------------------------------------------------- glyphs
 * The small marks around the head. Ours. A "!!" cannot be reached by
 * morphing a capsule and neither can a heart, so like bloub's decor these
 * cross in OPACITY, never in geometry. The three face glyphs replace the
 * eyes (eyeAlpha 0) rather than sitting beside them.
 *
 * Each also carries a MOTION: a loop of its own, authored once here rather
 * than per state, because drifting upward is a property of a "zzz" and not
 * of being asleep. A state still only says how much of the glyph is showing.
 * The motion reads absolute time, so a held state keeps moving, and it is
 * frozen at 0 for a resting frame so the baked snippet is stable.
 *
 * `at` is where the glyph sits; anything that scales or rotates is authored
 * around its own origin so it does not swing away from the head when it does.
 */

const zed = (x, y, s) => `M${x} ${y}h${s}l${-s} ${s}h${s}`;
/** Four-point star: the arms pinch at the centre, which is what reads as a spark. */
const spark4 = (s) =>
  `M0 ${-s}Q${s * 0.12} ${-s * 0.12} ${s} 0` +
  `Q${s * 0.12} ${s * 0.12} 0 ${s}` +
  `Q${-s * 0.12} ${s * 0.12} ${-s} 0` +
  `Q${-s * 0.12} ${-s * 0.12} 0 ${-s}z`;
/** Archimedean spiral, stroked. The dizzy eye. */
const spiral = (turns, r) => {
  let d = "M0 0";
  const steps = turns * 12;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * turns * TAU;
    const k = (i / steps) * r;
    d += `L${r2(Math.cos(a) * k)} ${r2(Math.sin(a) * k)}`;
  }
  return d;
};
/** A teardrop, point up. Sweat and tears are the same shape at two sizes. */
const drop = (s) =>
  `M0 ${-s}C${s * 0.7} ${-s * 0.1} ${s * 0.8} ${s * 0.35} 0 ${s * 0.85}` +
  `C${-s * 0.8} ${s * 0.35} ${-s * 0.7} ${-s * 0.1} 0 ${-s}z`;

const heart = (x, y, s) =>
  `M${x} ${y + s * 0.9}c${-s * 1.3} ${-s * 0.9} ${-s * 0.8} ${-s * 1.9} 0 ${-s * 1.1}` +
  `c${s * 0.8} ${-s * 0.8} ${s * 1.3} ${s * 0.2} 0 ${s * 1.1}z`;

/** A loop that fades in and out once per cycle, starting part-way in so a
 *  frozen frame shows something rather than the invisible moment at u = 0. */
const cycle = (t, rate) => (t * rate + 0.25) % 1;
const arch = (u) => Math.sin(u * Math.PI);
/** Twinkle: never fully out, never twice at the same moment. */
const twinkle = (t, rate, phase) => 0.5 + 0.5 * Math.sin(t * rate + phase);

const GLYPHS = {
  spark: {
    at: [94, -118],
    html: `<path d="M-16 14L-2 -4M10 22L30 14M-30 -2L-24 -24"/>`,
    stroke: true,
    motion: (t) => ({ s: 1 + 0.16 * Math.sin(t * 7) })
  },
  think: {
    at: [123, -123],
    html: `<circle cx="-11" cy="11" r="9"/><circle cx="11" cy="-11" r="6"/>`,
    motion: (t) => ({ dy: -4 * Math.sin(t * 1.2) })
  },
  zzz: {
    at: [0, 0],
    html: `<path d="${zed(96, -120, 16)}${zed(120, -140, 12)}${zed(138, -154, 9)}"/>`,
    stroke: true,
    motion: (t) => {
      const u = cycle(t, 0.3);
      return { dy: -30 * u, o: arch(u) };
    }
  },
  question: {
    at: [105, -114],
    html: `<path d="M-9 -18a15 15 0 1 1 15 15v9"/><circle cx="6" cy="18" r="5"/>`,
    stroke: true,
    motion: (t) => ({ r: Math.sin(t * 2.2) * 7 })
  },
  hearts: {
    at: [0, 0],
    html: `<path class="fx-paw-warm" d="${heart(-16, -122, 13)}${heart(30, -140, 9)}"/>`,
    motion: (t) => {
      const u = cycle(t, 0.35);
      return { dx: 6 * Math.sin(u * TAU), dy: -26 * u, o: arch(u) };
    }
  },
  waves: {
    at: [100, -40],
    html: `<path d="M4 -56a26 26 0 0 1 20 -24M12 -34a44 44 0 0 1 34 -40M20 -12a62 62 0 0 1 48 -56"/>`,
    stroke: true,
    motion: (t) => {
      const u = cycle(t, 0.9);
      return { s: 0.86 + 0.28 * u, o: arch(u) };
    }
  },
  speed: {
    at: [0, 0],
    html: `<path d="M-118 -30h-42M-126 -6h-54M-118 18h-38"/>`,
    stroke: true,
    motion: (t) => {
      const u = cycle(t, 1.6);
      return { dx: -26 * u, o: arch(u) };
    }
  },
  // One emitter, three instances. Staggered phases are what make it read as
  // twinkling rather than pulsing, and the index is what staggers them.
  sparks: {
    count: 3,
    at: (i) => [[104, -108], [140, -76], [76, -134]][i],
    html: (i) => `<path d="${spark4([20, 12, 9][i])}"/>`,
    motion: (t, i) => {
      const k = twinkle(t, [2.1, 2.7, 3.4][i], [0, 2.1, 4.3][i]);
      return { s: 0.5 + 0.62 * k, r: [12, -16, 20][i] * k, o: 0.35 + 0.65 * k };
    }
  },

  /* -------- the anime shorthand. Each is a mark, not a state: they layer. */

  /** Awkwardness, in one bead. Slides down the temple and goes. */
  sweat: {
    at: [70, -66],
    html: `<path class="fx-paw-cool" d="${drop(17)}"/>`,
    motion: (t) => {
      const u = cycle(t, 0.5);
      return { dy: 34 * u, s: 1 - 0.25 * u, o: arch(u) };
    }
  },
  /** The vein pop. Four strokes, and it throbs rather than fades. */
  angerCross: {
    at: [54, -84],
    stroke: true,
    html: `<path class="fx-paw-hot" d="M-13 -4h26M-13 4h26M-4 -13v26M4 -13v26"/>`,
    motion: (t) => ({ s: 0.88 + 0.18 * Math.abs(Math.sin(t * 5)) })
  },
  /** Vertical gloom down the crown. The one mark that is a colour, not a shape. */
  despair: {
    count: 5,
    behind: false,
    at: (i) => [-46 + i * 23, -96],
    stroke: true,
    html: `<path class="fx-paw-cool" d="M0 0v54"/>`,
    motion: (t, i) => ({ o: 0.35 + 0.4 * twinkle(t, 1.1, i * 0.9), s: 0.8 + 0.2 * (i % 2) })
  },
  /** Overheating. Two columns off the ear tops, curling as they climb. */
  steam: {
    count: 4,
    at: (i) => [(i < 2 ? -1 : 1) * 92, -62],
    stroke: true,
    html: `<path d="M0 0c-7 -9 7 -16 0 -25"/>`,
    motion: (t, i) => {
      const u = cycle(t + i * 0.31, 0.65);
      return { dx: (i < 2 ? -1 : 1) * 16 * u, dy: -46 * u, s: 0.6 + 0.7 * u, o: arch(u) * 0.85 };
    }
  },
  /** Two streams, not two drops. Anime cries in quantity. */
  tears: {
    count: 4,
    onFace: true,
    at: (i) => [(i < 2 ? -1 : 1) * 41, 18],
    html: `<path class="fx-paw-cool" d="${drop(9)}"/>`,
    motion: (t, i) => {
      const u = cycle(t + i * 0.27, 0.85);
      return { dy: 70 * u, s: 1 - 0.35 * u, o: arch(u) };
    }
  },
  /** Determination, or rage. Tongues out of step, which is the whole trick. */
  flame: {
    count: 6,
    behind: true,
    at: (i) => [-56 + i * 22, -96],
    html: `<path class="fx-paw-hot" d="M0 0c-13 -16 6 -22 0 -44c10 16 16 26 0 44z"/>`,
    motion: (t, i) => {
      const k = twinkle(t * 2.1, 3.4, i * 1.7);
      return { dy: -12 * k, s: 0.55 + 0.75 * k, o: 0.45 + 0.5 * k };
    }
  },
  /** Powering up. Streaks climbing past, behind the head. */
  aura: {
    count: 6,
    behind: true,
    at: (i) => [(i % 2 ? 1 : -1) * (104 + (i % 3) * 12), 40],
    stroke: true,
    html: `<path class="fx-paw-warmline" d="M0 0v-34"/>`,
    motion: (t, i) => {
      const u = cycle(t + i * 0.17, 1.25);
      return { dy: -120 * u, s: 0.7 + 0.5 * (1 - u), o: arch(u) };
    }
  },
  /**
   * The impact star, behind, so the head punches through it. It is a FLASH:
   * pale, huge and almost gone within a second, then a faint hold. A dark
   * red star sitting there at half opacity read as a stain on the wall.
   */
  burst: {
    behind: true,
    at: [0, -10],
    html: `<path class="fx-paw-flash" d="M0 -150L26 -66L104 -104L54 -30L150 -12L54 14L104 96L26 44L0 130L-26 44L-104 96L-54 14L-150 -12L-54 -30L-104 -104L-26 -66z"/>`,
    motion: (t) => ({
      s: 0.9 + 0.5 * Math.exp(-t * 5),
      o: 0.18 + 0.82 * Math.exp(-t * 2.4),
      r: 8 * Math.sin(t * 3)
    })
  },
  /** Briefly innocent. */
  halo: {
    at: [0, -132],
    stroke: true,
    html: `<ellipse cx="0" cy="0" rx="34" ry="10"/>`,
    motion: (t) => ({ dy: Math.sin(t * 1.4) * 4 })
  },
  /** Briefly not. */
  horns: {
    at: [0, -92],
    html: `<path class="fx-paw-hot" d="M-58 4C-58 -18 -48 -30 -36 -34C-40 -22 -42 -12 -40 4zM58 4C58 -18 48 -30 36 -34C40 -22 42 -12 40 4z"/>`,
    motion: (t) => ({ s: 0.94 + 0.06 * Math.sin(t * 3) })
  },
  /** Deep sleep, the comedy version: it inflates and it pops. */
  bubble: {
    at: [82, -22],
    stroke: true,
    html: `<circle cx="0" cy="0" r="16"/>`,
    motion: (t) => {
      const u = cycle(t, 0.28);
      // grows for most of the cycle, then is simply gone -- a pop is an
      // absence, not a shrink
      return u > 0.9 ? { o: 0 } : { s: 0.25 + u, o: 0.35 + 0.5 * u };
    }
  },

  /* -------- faces: these REPLACE the eyes, so a state sets eyeAlpha 0 */

  /** Knocked sideways. */
  faceSpiral: {
    onFace: true,
    at: [0, 0],
    stroke: true,
    html: `<g transform="translate(-41 -6)"><path d="${spiral(2.2, 20)}"/></g>` +
      `<g transform="translate(41 -6)"><path d="${spiral(2.2, 20)}"/></g>`,
    motion: (t) => ({ r: Math.sin(t * 1.6) * 6 })
  },
  /** Awestruck. Four-point stars where the eyes were. */
  faceStar: {
    onFace: true,
    at: [0, -6],
    html: `<g transform="translate(-41 0)"><path d="${spark4(26)}"/></g>` +
      `<g transform="translate(41 0)"><path d="${spark4(26)}"/></g>`,
    motion: (t) => ({ s: 0.92 + 0.12 * Math.abs(Math.sin(t * 3.2)) })
  },

  /* -------- and one that sits WITH the eyes rather than instead of them */

  /** Flustered. Two warm ovals under the eyes. */
  blush: {
    onFace: true,
    at: [0, 26],
    html: `<g class="fx-paw-warm"><ellipse cx="-52" cy="0" rx="17" ry="9"/>` +
      `<ellipse cx="52" cy="0" rx="17" ry="9"/></g>`,
    motion: (t) => ({ o: 0.72 + 0.18 * Math.sin(t * 2.2) })
  },

  faceHappy: {
    onFace: true,
    at: [0, 0],
    html: `<path d="M-51 0q18 -22 36 0M15 0q18 -22 36 0"/>`,
    stroke: true
  },
  faceX: {
    onFace: true,
    at: [0, 0],
    html: `<path d="M-42 -16l16 16l-16 16M42 -16l-16 16l16 16"/>`,
    stroke: true
  },
  faceLove: {
    onFace: true,
    at: [0, 0],
    html: `<path class="fx-paw-warm" d="${heart(-33, -10, 15)}${heart(33, -10, 15)}"/>`
  }
};

const GLYPH_IDS = Object.keys(GLYPHS);

/**
 * A glyph with `count` is an EMITTER: one definition, several instances, each
 * given its index so it can carry its own phase. Steam, tears and flame are
 * all the same thing -- a handful of elements doing the same motion out of
 * step -- and writing them as one glyph each beats writing fifteen.
 *
 * Instances are keyed "id#i". A frame names them individually, so the
 * ephemeral layer adds and removes them like any other glyph.
 */
const baseOf = (key) => {
  const i = key.indexOf("#");
  return i < 0 ? key : key.slice(0, i);
};
const indexOf = (key) => {
  const i = key.indexOf("#");
  return i < 0 ? 0 : Number(key.slice(i + 1));
};
/** Per-instance values may be plain or a function of the index. */
const per = (v, i) => (typeof v === "function" ? v(i) : v);

/** One glyph's group, as markup. The same shape draw() builds on demand. */
function glyphMarkup(key, f) {
  const g = GLYPHS[baseOf(key)];
  return `<g class="fx-paw-glyph${g.stroke ? " fx-paw-stroke" : ""}" data-g="${key}"` +
    ` opacity="${r2(f.o)}" transform="${f.m}">${per(g.html, indexOf(key))}</g>`;
}

/** Where a glyph sits this frame, as one transform. */
function glyphTransform(key, t) {
  const g = GLYPHS[baseOf(key)];
  const i = indexOf(key);
  const m = g.motion ? g.motion(t, i) : {};
  const at = per(g.at, i);
  const x = r2(at[0] + (m.dx ?? 0));
  const y = r2(at[1] + (m.dy ?? 0));
  const rot = m.r ? ` rotate(${r2(m.r)})` : "";
  const sc = m.s != null ? ` scale(${r2(m.s)})` : "";
  return `translate(${x} ${y})${rot}${sc}`;
}

/* ------------------------------------------------------------------ poses */

const ear = (angle = 0, lift = 0) => ({ angle, lift });
/** A mouth. Absent unless a state asks, which is why alpha is an argument. */
const mouth = (curve = 0, open = 0, w = 1, alpha = 1) => ({ curve, open, w, alpha });
/**
 * An eye, as multipliers of whatever the drawing's own eye is. States say
 * "a tenth wider", never a size in head half-widths, so one state table
 * serves every mascot.
 */
const eye = (w = 1, h = 1, open = 1, tilt = 0) => ({ w, h, open, tilt });

function basePose(over = {}) {
  return {
    rot: 0,
    sx: 1,
    sy: 1,
    cx: 0,
    cy: 0,
    ears: { l: ear(), r: ear() },
    gaze: { ...REST_GAZE },
    splitScale: 1,
    eyes: [eye(), eye()],
    eyeAlpha: 1,
    /**
     * The mouth. alpha 0 by default, and on every state written before it
     * existed, because the Paw is drawn without one and a mascot that always
     * has a mouth is a different character.
     */
    mouth: { curve: 0, open: 0, w: 1, alpha: 0 },
    wander: 1,
    /** bloom strength 0..1; states pulse it, sample() adds a slow breath */
    glow: 0.5,
    /** how much of the rim is spectrum rather than the art's own 0..1 */
    rainbow: 0,
    /** a flat colour over the rim, 0..1, and the hue it takes */
    tint: 0,
    tintHue: 0,
    glyphs: {},
    ...over
  };
}

const lerpEar = (a, b, t) => ({ angle: lerp(a.angle, b.angle, t), lift: lerp(a.lift, b.lift, t) });
const lerpEye = (a, b, t) => ({
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  open: lerp(a.open, b.open, t),
  tilt: lerp(a.tilt, b.tilt, t)
});

/**
 * Interpolate two poses. Everything on the rig is a number and lerps; the
 * glyphs cross in opacity, so a glyph present on one side only fades
 * against nothing rather than morphing into the wrong mark.
 */
function blendPose(a, b, t) {
  const glyphs = {};
  for (const k in a.glyphs) glyphs[k] = a.glyphs[k] * (1 - t);
  for (const k in b.glyphs) glyphs[k] = (glyphs[k] ?? 0) + b.glyphs[k] * t;
  return {
    rot: lerp(a.rot, b.rot, t),
    sx: lerp(a.sx, b.sx, t),
    sy: lerp(a.sy, b.sy, t),
    cx: lerp(a.cx, b.cx, t),
    cy: lerp(a.cy, b.cy, t),
    ears: { l: lerpEar(a.ears.l, b.ears.l, t), r: lerpEar(a.ears.r, b.ears.r, t) },
    gaze: {
      yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
      pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
      roll: lerp(a.gaze.roll, b.gaze.roll, t)
    },
    splitScale: lerp(a.splitScale, b.splitScale, t),
    eyes: [lerpEye(a.eyes[0], b.eyes[0], t), lerpEye(a.eyes[1], b.eyes[1], t)],
    eyeAlpha: lerp(a.eyeAlpha, b.eyeAlpha, t),
    mouth: {
      curve: lerp(a.mouth.curve, b.mouth.curve, t),
      open: lerp(a.mouth.open, b.mouth.open, t),
      w: lerp(a.mouth.w, b.mouth.w, t),
      alpha: lerp(a.mouth.alpha, b.mouth.alpha, t)
    },
    mouth: {
      curve: lerp(a.mouth.curve, b.mouth.curve, t),
      open: lerp(a.mouth.open, b.mouth.open, t),
      w: lerp(a.mouth.w, b.mouth.w, t),
      alpha: lerp(a.mouth.alpha, b.mouth.alpha, t)
    },
    wander: lerp(a.wander, b.wander, t),
    glow: lerp(a.glow, b.glow, t),
    rainbow: lerp(a.rainbow, b.rainbow, t),
    tint: lerp(a.tint, b.tint, t),
    // Hue by the shorter way round, so red to violet does not sweep the wheel.
    tintHue: a.tintHue + (((b.tintHue - a.tintHue + 540) % 360) - 180) * t,
    glyphs
  };
}

/* ------------------------------------------------------------ the states
 * Each is a function of `t`, the seconds elapsed IN that state, so a state
 * can animate on its own (the working shake, the excited bounce) while the
 * engine separately crossfades it against whatever it replaced. */

const STATES = {
  idle: { morph: 0.45, pose: () => basePose() },

  happy: {
    morph: 0.35,
    blinkIn: true,
    pose: () => basePose({
      ears: { l: ear(-0.10), r: ear(-0.10) },
      sy: 0.98,
      eyeAlpha: 0,
      glyphs: { faceHappy: 1 }
    })
  },

  excited: {
    morph: 0.3,
    pose: (t) => {
      const b = Math.sin(t * 9) * 0.035 * Math.exp(-t * 0.35);
      return basePose({
        cy: -Math.abs(b) * 1.4,
        sy: 1 + b,
        sx: 1 - b * 0.6,
        ears: { l: ear(-0.30, 0.04), r: ear(-0.34, 0.05) },
        eyes: [eye(1.1, 1.05), eye(1.1, 1.05)],
        glow: 0.75 + Math.sin(t * 6) * 0.22,
        glyphs: { spark: 1 }
      });
    }
  },

  curious: {
    morph: 0.5,
    pose: () => basePose({
      rot: -0.13,
      gaze: { yaw: 9, pitch: 4, roll: -4 },
      ears: { l: ear(-0.42, 0.05), r: ear(0.10) },
      eyes: [eye(1.05, 1), eye(0.95, 0.95)]
    })
  },

  thinking: {
    morph: 0.5,
    pose: (t) => basePose({
      rot: 0.06,
      gaze: { yaw: -16 + Math.sin(t * 0.9) * 3, pitch: 13, roll: 3 },
      wander: 0.35,
      ears: { l: ear(0.10), r: ear(-0.14, 0.03) },
      eyes: [eye(1, 0.9), eye(1, 0.9)],
      glyphs: { think: 1 }
    })
  },

  working: {
    morph: 0.3,
    pose: (t) => basePose({
      cx: Math.sin(t * 16) * 0.012,
      ears: { l: ear(0.26), r: ear(0.22) },
      wander: 0.2,
      // narrowed and mirrored: the tilt is what reads as effort rather than anger
      eyes: [eye(0.9, 0.62, 1, 13), eye(0.9, 0.62, 1, -13)],
      glow: 0.55 + Math.sin(t * 4) * 0.1,
      glyphs: { speed: 1 }
    })
  },

  focused: {
    morph: 0.4,
    pose: () => basePose({
      wander: 0.15,
      ears: { l: ear(0.06), r: ear(0.06) },
      eyes: [eye(0.92, 0.58, 1, 11), eye(0.92, 0.58, 1, -11)]
    })
  },

  surprised: {
    morph: 0.18,
    blinkIn: true,
    pose: (t) => basePose({
      sy: 1 + 0.03 * Math.exp(-t * 4),
      ears: { l: ear(-0.38, 0.05), r: ear(-0.35, 0.05) },
      splitScale: 1.05,
      eyes: [eye(1.25, 0.72), eye(1.25, 0.72)],
      glow: 0.5 + 0.5 * Math.exp(-t * 2),
      glyphs: { spark: 1 }
    })
  },

  sleeping: {
    morph: 0.7,
    pose: (t) => basePose({
      cy: 0.02 + Math.sin(t * 0.8) * 0.012,
      sy: 1 + Math.sin(t * 0.8) * 0.02,
      ears: { l: ear(0.30), r: ear(0.30) },
      gaze: { yaw: 0, pitch: -8, roll: 0 },
      wander: 0,
      glow: 0.18,
      eyes: [eye(1, 0.5, 0.04), eye(1, 0.5, 0.04)],
      glyphs: { zzz: 1 }
    })
  },

  wink: {
    morph: 0.2,
    /**
     * A wink is a gesture, not a face. Held as a pose it stops being a wink
     * and becomes an eye that is simply shut -- which is what it looked like
     * on any surface that sits in one state rather than passing through it.
     *
     * So it winks on a loop: shut on arrival, because a wink fired by a hook
     * has to land on the beat the event did, open again after half a second,
     * then go round once more. Two and a half seconds apart, so a reader
     * catches the second one without feeling blinked at.
     */
    pose: (t) => {
      const k = t % 2.5;
      const shut = k < 0.55 ? 1
        : k < 0.8 ? 1 - (k - 0.55) / 0.25
        : k < 2.4 ? 0
        : (k - 2.4) / 0.1;
      return basePose({
        rot: 0.05,
        ears: { l: ear(-0.12), r: ear(-0.28, 0.04) },
        eyes: [eye(1, 1), eye(1 + 0.15 * shut, 1 - 0.55 * shut, 1 - 0.98 * shut)],
        glyphs: { spark: 0.25 + 0.45 * shut }
      });
    }
  },

  confused: {
    morph: 0.45,
    pose: () => basePose({
      rot: 0.12,
      gaze: { yaw: 6, pitch: -4, roll: 7 },
      ears: { l: ear(0.34), r: ear(-0.32, 0.04) },
      eyes: [eye(1.1, 0.95), eye(0.8, 0.7)],
      glyphs: { question: 1 }
    })
  },

  sad: {
    morph: 0.55,
    pose: () => basePose({
      cy: 0.035,
      sy: 0.965,
      gaze: { yaw: 0, pitch: -13, roll: 0 },
      wander: 0.4,
      glow: 0.3,
      ears: { l: ear(0.5, -0.06), r: ear(0.5, -0.06) },
      eyes: [eye(0.85, 0.52, 1, -9), eye(0.85, 0.52, 1, 9)]
    })
  },

  love: {
    morph: 0.4,
    blinkIn: true,
    pose: (t) => basePose({
      cy: Math.sin(t * 2.4) * 0.012,
      ears: { l: ear(-0.18), r: ear(-0.18) },
      eyeAlpha: 0,
      glow: 0.7 + Math.sin(t * 2.4) * 0.2,
      glyphs: { faceLove: 1, hearts: 1 }
    })
  },

  celebrating: {
    morph: 0.28,
    pose: (t) => {
      const b = Math.sin(t * 7) * 0.03 * Math.exp(-t * 0.5);
      return basePose({
        cy: -Math.abs(b) * 1.6,
        sy: 1 + b,
        ears: { l: ear(-0.42, 0.05), r: ear(-0.38, 0.05) },
        eyeAlpha: 0,
        glow: 0.8 + Math.sin(t * 7) * 0.2,
        glyphs: { faceX: 1, spark: 1 }
      });
    }
  },

  /**
   * The one state with a spectrum rim. The hue travels because the engine
   * hands the renderer an angle, not because CSS keyframes run: a second
   * clock would break pause, scrub and the resting frame the snippet bakes.
   */
  creative: {
    morph: 0.55,
    // A full turn on arrival. The eyes ride a sphere, so this takes them
    // round the back and returns them from the other side; -360 is the same
    // angle as 0, so it costs nothing at the far end.
    spinIn: 360,
    pose: (t) => {
      // An idea landing, every few seconds: a fast rise and a slow fall, not
      // a sine. A constant shimmer reads as decoration; a beat reads as
      // something happening.
      const p = t % 4.2;
      const beat = p < 0.12 ? p / 0.12 : Math.exp(-(p - 0.12) * 3.2);
      const w = 1.06 + beat * 0.1;
      return basePose({
        rot: Math.sin(t * 0.7) * 0.04,
        cy: Math.sin(t * 1.1) * 0.014 - beat * 0.02,
        ears: { l: ear(-0.26 - beat * 0.12, 0.04), r: ear(-0.34 - beat * 0.14, 0.05) },
        gaze: { yaw: Math.sin(t * 0.5) * 9, pitch: 6, roll: 0 },
        wander: 0.5,
        eyes: [eye(w, w), eye(w, w)],
        glow: 0.68 + Math.sin(t * 1.6) * 0.14 + beat * 0.28,
        rainbow: 1,
        glyphs: { sparks: 1 }
      });
    }
  },

  /* ---------------------------------------------------------------------
   * The anime shorthand. Each of these leans on a mark, a tint or a mouth
   * rather than on eye shape alone, because eye shape is most of what the
   * first sixteen already had and it was running out.
   * ------------------------------------------------------------------- */

  /** Caught out. The bead does the work; the pose only gets out of its way. */
  awkward: {
    morph: 0.35,
    blinkIn: true,
    pose: () => basePose({
      rot: 0.06,
      gaze: { yaw: -13, pitch: -3, roll: 3 },
      ears: { l: ear(0.2), r: ear(0.34) },
      eyes: [eye(1.05, 0.7), eye(0.9, 0.62)],
      mouth: mouth(-0.35, 0.05, 0.7),
      glow: 0.4,
      glyphs: { sweat: 1 }
    })
  },

  /** Irritated, not yet angry. The vein throbs; nothing else has to shout. */
  annoyed: {
    morph: 0.3,
    pose: (t) => basePose({
      cx: Math.sin(t * 13) * 0.004,
      ears: { l: ear(0.3), r: ear(0.26) },
      eyes: [eye(0.95, 0.42, 1, 16), eye(0.95, 0.42, 1, -16)],
      mouth: mouth(-0.5, 0.02, 0.55),
      tint: 0.55,
      tintHue: 12,
      glow: 0.5,
      glyphs: { angerCross: 1 }
    })
  },

  /** The blue verticals. Everything else drains to match. */
  gloomy: {
    morph: 0.6,
    pose: () => basePose({
      cy: 0.05,
      sy: 0.95,
      gaze: { yaw: 0, pitch: -20, roll: 0 },
      ears: { l: ear(0.55, -0.05), r: ear(0.55, -0.05) },
      wander: 0.2,
      eyes: [eye(0.85, 0.4, 1, -6), eye(0.85, 0.4, 1, 6)],
      mouth: mouth(-0.6, 0.03, 0.5),
      tint: 0.5,
      tintHue: 215,
      glow: 0.12,
      glyphs: { despair: 1 }
    })
  },

  /** Knocked sideways. The spirals replace the eyes entirely. */
  dizzy: {
    morph: 0.35,
    blinkIn: true,
    pose: (t) => basePose({
      rot: Math.sin(t * 2.6) * 0.09,
      cy: Math.sin(t * 5.2) * 0.012,
      ears: { l: ear(0.18 + Math.sin(t * 2.2) * 0.1), r: ear(0.22 - Math.sin(t * 2.2) * 0.1) },
      eyeAlpha: 0,
      mouth: mouth(-0.2, 0.35, 0.5),
      glow: 0.35,
      glyphs: { faceSpiral: 1 }
    })
  },

  /** Awestruck. Stars, a blush, and a mouth that cannot stay shut. */
  starstruck: {
    morph: 0.3,
    pose: (t) => basePose({
      cy: -Math.abs(Math.sin(t * 3.4)) * 0.018,
      ears: { l: ear(-0.36, 0.05), r: ear(-0.4, 0.05) },
      eyeAlpha: 0,
      mouth: mouth(0.7, 0.55, 0.75),
      glow: 0.8 + Math.sin(t * 4) * 0.15,
      glyphs: { faceStar: 1, blush: 0.8, sparks: 0.8 }
    })
  },

  /** Anime cries in quantity, so the tears are an emitter and not two drops. */
  crying: {
    morph: 0.4,
    pose: (t) => basePose({
      cy: 0.03 + Math.sin(t * 7) * 0.006,
      ears: { l: ear(0.6, -0.05), r: ear(0.58, -0.05) },
      gaze: { yaw: 0, pitch: -8, roll: 0 },
      eyes: [eye(1.1, 0.3, 1, -12), eye(1.1, 0.3, 1, 12)],
      mouth: mouth(-0.8, 0.45, 0.7),
      tint: 0.3,
      tintHue: 205,
      glow: 0.3,
      glyphs: { tears: 1 }
    })
  },

  /** Too much load. Steam off both ears and the colour to go with it. */
  overheated: {
    morph: 0.4,
    pose: (t) => basePose({
      sy: 1 + Math.sin(t * 6) * 0.012,
      ears: { l: ear(0.14), r: ear(0.1) },
      eyes: [eye(0.9, 0.34, 1, 8), eye(0.9, 0.34, 1, -8)],
      mouth: mouth(-0.2, 0.3, 0.6),
      tint: 0.45,
      tintHue: 20,
      glow: 0.6 + Math.sin(t * 5) * 0.12,
      glyphs: { steam: 1 }
    })
  },

  /** Full send. Flame behind, a yell in front. */
  firedUp: {
    morph: 0.3,
    blinkIn: true,
    pose: (t) => basePose({
      cy: -0.02 - Math.abs(Math.sin(t * 5)) * 0.012,
      sy: 1.03,
      ears: { l: ear(-0.5, 0.05), r: ear(-0.46, 0.05) },
      eyes: [eye(1.15, 0.55, 1, 14), eye(1.15, 0.55, 1, -14)],
      mouth: mouth(-0.15, 0.85, 0.85),
      tint: 0.7,
      tintHue: 18,
      glow: 0.9,
      glyphs: { flame: 1 }
    })
  },

  /** Charging. The aura climbs, the glow builds, nothing else moves much. */
  powering: {
    morph: 0.55,
    pose: (t) => basePose({
      cy: -Math.abs(Math.sin(t * 1.6)) * 0.02,
      ears: { l: ear(-0.3, 0.05), r: ear(-0.3, 0.05) },
      eyes: [eye(1.08, 0.95), eye(1.08, 0.95)],
      wander: 0.2,
      tint: 0.6,
      tintHue: 44,
      glow: 0.75 + Math.sin(t * 2.2) * 0.22,
      glyphs: { aura: 1 }
    })
  },

  /** One frame of impact, then the recoil. The burst is behind the head. */
  shocked: {
    morph: 0.12,
    blinkIn: true,
    pose: (t) => basePose({
      cy: 0.03 * Math.exp(-t * 5),
      sx: 1 + 0.05 * Math.exp(-t * 6),
      sy: 1 - 0.05 * Math.exp(-t * 6),
      ears: { l: ear(-0.6, 0.05), r: ear(-0.56, 0.05) },
      splitScale: 1.06,
      eyes: [eye(1.35, 0.8), eye(1.35, 0.8)],
      mouth: mouth(0, 1, 0.42),
      tint: 0.6 * Math.exp(-t * 2.2),
      tintHue: 36,
      glow: 0.4 + 0.6 * Math.exp(-t * 3),
      glyphs: { burst: 1 }
    })
  },

  /** The smirk. Asymmetry is the whole expression, so nothing here matches. */
  smug: {
    morph: 0.4,
    pose: () => basePose({
      rot: -0.07,
      gaze: { yaw: 11, pitch: 5, roll: -4 },
      ears: { l: ear(-0.2, 0.04), r: ear(0.16) },
      eyes: [eye(1, 0.42, 1, 15), eye(0.95, 0.72, 1, -4)],
      mouth: mouth(0.75, 0.06, 0.5),
      glow: 0.55
    })
  },

  /** Jitome: the flat unimpressed eye. No mark at all, which is the joke. */
  deadpan: {
    morph: 0.25,
    pose: () => basePose({
      ears: { l: ear(0.24), r: ear(0.22) },
      wander: 0.08,
      eyes: [eye(1.18, 0.2), eye(1.18, 0.2)],
      mouth: mouth(-0.1, 0.02, 0.36),
      glow: 0.3
    })
  },

  listening: {
    morph: 0.4,
    pose: (t) => basePose({
      rot: -0.05,
      ears: { l: ear(-0.2), r: ear(-0.45 + Math.sin(t * 2.2) * 0.05, 0.05) },
      gaze: { yaw: 7, pitch: 2, roll: -2 },
      eyes: [eye(1, 1.02), eye(1, 1.02)],
      glow: 0.6 + Math.sin(t * 2.2) * 0.15,
      glyphs: { waves: 1 }
    })
  }
};

/* ------------------------------------------------------------- the mood space
 *
 * The sixteen states are AUTHORED: each is a hand-tuned set of numbers, and
 * that is why they read well. What they cannot do is sit between two of
 * themselves. An agent's condition is not one of sixteen labels -- it is
 * confidence 0.2 and load 0.8, and snapping that to the nearer named state
 * throws away most of what it knew.
 *
 * So: three axes, and any point on them is a face. The named states stay
 * exactly as they are and are not generated from this; a point is simply
 * another way to drive the same rig.
 *
 *   valence    -1 badly … +1 well          how it is going
 *   arousal     0 asleep … 1 racing        how much is happening
 *   attention   0 inward … 1 on you        where it is pointed
 *
 * Each axis is given ONE job per part of the rig wherever possible, because
 * an axis that quietly nudges everything is impossible to tune and
 * impossible to read back. Where two axes do meet on a number, the comment
 * says which wins and why.
 *
 * WHAT A POINT CANNOT REACH, said plainly: wink is an asymmetry, happy, love
 * and celebrating replace the eyes with a drawn face, and creative carries a
 * spectrum rim. Those are characters, not coordinates. A mood gives you the
 * capsule-eyed range; the rest stay presets.
 */

export const NEUTRAL_MOOD = { valence: 0, arousal: 0.45, attention: 0.5 };

/** Where each named state sits, near enough to read the space by. */
export const MOOD_PRESETS = {
  idle: { valence: 0.05, arousal: 0.4, attention: 0.45 },
  excited: { valence: 0.8, arousal: 0.95, attention: 0.7 },
  curious: { valence: 0.25, arousal: 0.6, attention: 0.85 },
  thinking: { valence: 0.05, arousal: 0.4, attention: 0.1 },
  working: { valence: 0.1, arousal: 0.7, attention: 0.15 },
  focused: { valence: 0.05, arousal: 0.6, attention: 0.2 },
  surprised: { valence: 0.1, arousal: 0.95, attention: 1 },
  sleeping: { valence: 0.05, arousal: 0, attention: 0 },
  confused: { valence: -0.3, arousal: 0.45, attention: 0.4 },
  sad: { valence: -0.75, arousal: 0.2, attention: 0.3 },
  listening: { valence: 0.2, arousal: 0.5, attention: 1 }
};

const MOOD_MORPH = 0.5;

/**
 * A point in the space -> a pose on the rig.
 *
 * `t` is seconds since the mood was set, so a mood breathes and shifts like
 * any state rather than standing still.
 */
export function moodPose(mood, t = 0) {
  const v = clamp(mood.valence ?? 0, -1, 1);
  const a = clamp(mood.arousal ?? 0.45, 0, 1);
  const at = clamp(mood.attention ?? 0.5, 0, 1);
  const down = Math.max(0, -v);
  const up = Math.max(0, v);

  // EARS carry valence and attention together, which is the one place two
  // axes genuinely meet: an ear says both "this is going well" and "I am
  // pointed at you", and on a real animal it is the same muscle.
  const ear1 = -0.34 * at - 0.26 * v + 0.30 * (0.55 - a);
  // A little asymmetry so the two ears never read as one rigid piece. It
  // rides arousal: a racing mascot is not symmetrical, a sleeping one is.
  const skew = 0.05 * a * Math.sin(t * 0.6);

  // EYES: height is arousal, width is attention. Keeping them on separate
  // axes is what lets "wide awake but not looking at you" exist at all.
  const h = 0.55 + 0.8 * a;
  const w = 0.86 + 0.32 * at;
  // Below a floor the lids simply close. Modelling drowsiness as a very
  // short eye instead looked like a squint, which reads as effort.
  const open = a < 0.12 ? 0.04 + (a / 0.12) * 0.9 : 1;
  // Mirrored tilt: outer corners down when it is going badly, faintly up
  // when it is going well. Same-sign tilt is a head roll, not an expression.
  const tilt = -13 * down + 5 * up;

  return basePose({
    // A low, unhappy mascot sits lower and rounder.
    cy: 0.03 * down * (1 - a),
    sy: 1 + 0.02 * (a - 0.5),
    ears: { l: ear(ear1 + skew, 0.05 * a * at), r: ear(ear1 - skew, 0.05 * a * at) },
    gaze: { yaw: 0, pitch: -11 * (1 - a) + 9 * v, roll: 0 },
    // Attention is literally how much the gaze stays put: a mascot thinking
    // about something else lets its eyes drift, and one watching you does not.
    wander: 0.15 + 0.9 * (1 - at),
    eyes: [eye(w, h, open, tilt), eye(w, h, open, -tilt)],
    glow: 0.12 + 0.55 * a + 0.28 * up
  });
}

/** A mood, as a state definition the engine can fade to like any other. */
const moodState = (mood) => ({
  morph: MOOD_MORPH,
  pose: (t) => moodPose(mood, t)
});

export const STATE_IDS = Object.keys(STATES);

/**
 * The ear swings the state table actually uses, read off the table rather
 * than kept as a constant beside it -- a constant is the kind of thing that
 * stops being true the first time someone adds a state. Sampled across time
 * because a state's ears can move on their own (listening's do).
 */
let swingRange = null;
function earSwingRange() {
  if (swingRange) return swingRange;
  let lo = 0;
  let hi = 0;
  let lift = 0;
  for (const id of STATE_IDS) {
    for (let t = 0; t <= 8; t += 0.25) {
      const p = STATES[id].pose(t);
      for (const e of [p.ears.l, p.ears.r]) {
        lo = Math.min(lo, -Math.abs(e.angle));
        hi = Math.max(hi, Math.abs(e.angle));
        lift = Math.max(lift, e.lift);
      }
    }
  }
  // the settle overshoots by about a tenth before it lands
  swingRange = { lo: lo * 1.12, hi: hi * 1.12, lift: lift * 1.12 };
  return swingRange;
}

/* ------------------------------------------------------------------- look
 * Where the Paw looks when something outside drives it: the pointer.
 * Ported from bloub src/bot/engine.ts, minus its `spin`.
 *
 * `yaw` and `pitch` are ABSOLUTE directions that REPLACE the pose's as `mix`
 * rises, and the ENGINE does that blend, not the caller: only the engine
 * knows the pose at this instant, so a caller compensating for it would read
 * the arriving value while the morph is still running and the eyes would
 * jump on every mood change. Absolute on both axes for the same reason --
 * relative, the eye height would follow each state's own gaze and drop the
 * moment the state changed. What carries an expression during tracking is
 * the SHAPE of its eyes, not where it looks; the pointer decides that.
 *
 * `wander` is separate from `mix`. When the pointer moves the idle drift has
 * to die down, or the Paw looks like it is hunting the cursor without ever
 * holding it. Left as one value, the gaze froze the moment tracking started.
 */
const NO_LOOK = { yaw: 0, pitch: 0, mix: 0, wander: 1 };

/**
 * A tour to travel ON THE WAY somewhere, in degrees, faded to nothing as it
 * arrives. Ported from bloub, where it serves the intro; here a state asks
 * for one on entry.
 *
 * It works because the eyes ride a sphere: a full turn takes them round the
 * back of the head and brings them back from the other side, and -360 being
 * the same angle as 0 means it changes nothing about where they end up. Flat
 * eyes cannot do this at all -- they would slide off the face.
 */
const SPIN_TIME = 1.1;

const lerpLook = (a, b, t) => ({
  yaw: lerp(a.yaw, b.yaw, t),
  pitch: lerp(a.pitch, b.pitch, t),
  mix: lerp(a.mix, b.mix, t),
  wander: lerp(a.wander, b.wander, t)
});

/* ------------------------------------------------------------- reactions
 *
 * Short-lived answers to something the reader did, layered on whatever pose
 * is current rather than replacing it. A poke is not a state: the mascot
 * does not stop thinking because you prodded it, it flinches and carries on
 * thinking.
 *
 * Each is a function of the time since it was set, so sample(t) stays pure
 * and a poke can be scrubbed back to like anything else. Same contract
 * setLook keeps, for the same reason.
 */

/** Squash, bounce, settle. One oscillation, spent inside its window. */
const pokeCurve = (k) => (k >= 1 ? 0 : Math.exp(-4 * k) * Math.cos(k * 9));
/** A rise too fast to see and a fall you do: a startle, not a swell. */
const startleCurve = (k) => (k >= 1 ? 0 : k < 0.08 ? k / 0.08 : Math.exp(-(k - 0.08) * 4.5));

const IMPULSE = {
  poke: { time: 0.7, curve: pokeCurve },
  startle: { time: 1.1, curve: startleCurve }
};

/* ----------------------------------------------------------------- engine
 * Ported from bloub src/bot/engine.ts. Two things matter here and both are
 * upstream's: sample(now) is a pure function of time, so pause, scrub and
 * re-reading a past date give byte-identical output; and setState is a DATED
 * setter that, when a change lands mid-fade, freezes the composite pose
 * currently on screen and fades from THAT. Without the freeze, the one slot
 * of history means a second change snaps back to the full previous pose.
 */
export class PawEngine {
  /**
   * Catch-up time for the gaze, seconds. Shorter than a state morph: a gaze
   * that follows should look attentive, not viscous. Because the target is
   * reset on every pointer move, this is also what gives tracking its
   * inertia -- the gaze never quite reaches a cursor that keeps moving.
   */
  static LOOK_MORPH = 0.24;

  constructor(initial = "idle", art = PAW_ART) {
    this.art = compileArt(art);
    this.cur = STATES[initial] ? initial : "idle";
    // The pose SOURCE, not the name: a mood is a definition with no entry in
    // the state table, and everything downstream -- the fade, the ear lag,
    // the frozen departure -- works the same either way once the engine
    // holds a def rather than a key.
    this.curDef = STATES[this.cur];
    this.prev = null;
    this.prevDef = null;
    this.frozen = null;
    this.tCur = 0;
    this.tPrev = 0;
    this.blinkAt = -10;
    this.look = NO_LOOK;
    this.lookPrev = NO_LOOK;
    this.lookAt = -10;
    this.lookMorph = PawEngine.LOOK_MORPH;
    /** kind -> { at, strength }; read by time, never ticked. */
    this.impulses = {};
    this.spinAt = -10;
    this.spinDeg = 0;
    this.hover = 0;
    this.hoverPrev = 0;
    this.hoverAt = -10;
    this.body = makeBody();
  }

  get state() {
    return this.cur;
  }

  /** Composite pose at `now`, fade included. Extracted so setState can freeze it. */
  composed(now) {
    const def = this.curDef;
    const pose = def.pose(Math.max(0, now - this.tCur));
    const since = now - this.tCur;
    // The ears finish after the head, so the window they share is longer.
    if (since >= def.morph * (1 + EAR_LAG)) return pose;
    const origin = this.frozen ?? (this.prevDef
      ? this.prevDef.pose(Math.max(0, now - this.tPrev))
      : null);
    if (!origin) return pose;
    // Ease-out, and the ratio is CLAMPED: reading a date before the change
    // would give a negative ratio that the ease extrapolates far past the pose.
    const out = blendPose(origin, pose, easeOutQuint(clamp(since / def.morph)));
    const ke = clamp((since - def.morph * EAR_LAG) / def.morph);
    const te = earSettle(ke);
    out.ears = {
      l: lerpEar(origin.ears.l, pose.ears.l, te),
      r: lerpEar(origin.ears.r, pose.ears.r, te)
    };
    return out;
  }

  /**
   * New look target, `null` to fall back to the state's own gaze.
   *
   * It departs from the CURRENT look, not from the previous target the way a
   * state change does: this is called on every pointer move, and departing
   * from the old target would rewind the gaze a notch before each catch-up,
   * so the tracking would shiver instead of gliding.
   *
   * A non-finite target is refused and the last one kept. One NaN, from a
   * getBoundingClientRect on a zero-sized box, would otherwise propagate to
   * every later frame and the Paw would never come to rest again.
   */
  setLook(look, now, morph = PawEngine.LOOK_MORPH) {
    if (look && !Number.isFinite(look.yaw + look.pitch + look.mix + look.wander)) return;
    this.lookPrev = this.lookAtTime(now);
    this.look = look ?? NO_LOOK;
    this.lookAt = now;
    this.lookMorph = morph;
  }

  /** Look in force at `now`, catch-up included. */
  lookAtTime(now) {
    const k = (now - this.lookAt) / this.lookMorph;
    if (k >= 1) return this.look;
    return lerpLook(this.lookPrev, this.look, easeOutQuint(clamp(k)));
  }

  setState(id, now) {
    if (!STATES[id] || id === this.cur) return;
    this.transition(STATES[id], id, now);
  }

  /**
   * Something the reader just did. `kind` is "poke" or "startle"; `strength`
   * scales it, so a slow drag and a flung pointer do not read the same.
   *
   * Re-setting restarts rather than accumulates: two pokes in quick
   * succession are two flinches, not one enormous one.
   */
  react(kind, now, strength = 1) {
    if (!IMPULSE[kind] || !Number.isFinite(now + strength)) return;
    this.impulses[kind] = { at: now, strength: clamp(strength, 0, 1) };
  }

  /** How much of an impulse is left at `now`, 0 once it is spent. */
  impulseAt(kind, now) {
    const i = this.impulses[kind];
    if (!i) return 0;
    const k = (now - i.at) / IMPULSE[kind].time;
    return k < 0 || k >= 1 ? 0 : IMPULSE[kind].curve(k) * i.strength;
  }

  /** Pointer over the mascot, or not. Eases rather than snapping. */
  setHover(on, now) {
    const next = on ? 1 : 0;
    if (next === this.hover) return;
    this.hoverPrev = this.hoverAtTime(now);
    this.hover = next;
    this.hoverAt = now;
  }

  hoverAtTime(now) {
    const k = (now - this.hoverAt) / 0.3;
    return k >= 1 ? this.hover : lerp(this.hoverPrev, this.hover, easeOutQuint(clamp(k)));
  }

  /**
   * A point in the mood space, faded to like any state.
   *
   * No same-value guard, unlike setState: a mood arrives from a slider or
   * from an agent's own numbers, so two calls are rarely identical and the
   * caller is entitled to nudge it as often as it likes.
   */
  setMood(mood, now) {
    this.transition(moodState(mood), "mood", now);
    this.mood = mood;
  }

  /** The shared half of a state change: whatever the new pose source is. */
  transition(def, id, now) {
    const midFade = this.prevDef !== null && now - this.tCur < this.curDef.morph;
    // The engine keeps ONE slot of history, so a change landing mid-fade
    // would otherwise depart from the full previous pose instead of the
    // partly blended one on screen. Freezing only in that case matters:
    // freezing always would stop the outgoing state animating during its
    // own fade.
    this.frozen = midFade ? this.composed(now) : null;
    this.prev = this.cur;
    this.prevDef = this.curDef;
    this.tPrev = this.tCur;
    this.cur = id;
    this.curDef = def;
    this.tCur = now;
    if (def.blinkIn) this.blinkAt = now;
    if (def.spinIn) {
      this.spinAt = now;
      this.spinDeg = def.spinIn;
    }
  }

  /** Restart on `id` with no history, as if the engine were new. */
  reset(id, now) {
    this.cur = STATES[id] ? id : "idle";
    this.curDef = STATES[this.cur];
    this.prev = null;
    this.prevDef = null;
    this.frozen = null;
    this.tCur = now;
    this.tPrev = now;
    this.blinkAt = -10;
    this.look = NO_LOOK;
    this.lookPrev = NO_LOOK;
    this.lookAt = -10;
  }

  sample(now, alive = true) {
    const pose = this.composed(now);
    const faceOn = pose.eyeAlpha > 0.01;

    // --- what the reader just did ----------------------------------------
    // Layered on the pose, not swapped for it. A poke oscillates through
    // zero on purpose: that IS the bounce, so the squash follows the curve
    // while the things that should only ever go one way take its positive
    // half.
    const poke = alive ? this.impulseAt("poke", now) : 0;
    const startle = alive ? this.impulseAt("startle", now) : 0;
    const hover = alive ? this.hoverAtTime(now) : 0;
    if (poke || startle || hover) {
      const hit = Math.max(poke, 0);
      pose.sx += 0.09 * poke;
      pose.sy -= 0.11 * poke;
      pose.cy += 0.035 * poke;
      const flick = 0.4 * poke - 0.3 * startle - 0.14 * hover;
      pose.ears.l.angle += flick;
      pose.ears.r.angle += flick;
      for (const e of pose.eyes) {
        e.w += 0.18 * startle + 0.06 * hover;
        e.h += 0.2 * startle - 0.12 * hit;
      }
      // Being looked at is a reason to look back, so the drift dies down.
      pose.wander *= 1 - 0.6 * hover;
      pose.glow = clamp(pose.glow + 0.28 * startle + 0.15 * hover + 0.2 * hit);
    }

    const look = this.lookAtTime(now);
    const life = alive
      ? liveliness(now, pose.wander * look.wander, faceOn)
      : { dYaw: 0, dPitch: 0, dRoll: 0, lid: 1, driftX: 0, driftY: 0, breath: 1 };

    const spinK = (now - this.spinAt) / SPIN_TIME;
    const spin = alive && spinK >= 0 && spinK < 1
      ? this.spinDeg * (1 - easeOutQuint(spinK))
      : 0;

    // The two aims REPLACE the pose's as `mix` rises; the drift is added
    // AFTER, so a head held toward the pointer still lives.
    const gaze = {
      // The spin is subtracted ON THE WAY and fades with arrival, so the eyes
      // travel the long way round without changing where they end up.
      yaw: lerp(pose.gaze.yaw, look.yaw, look.mix) + life.dYaw - spin,
      pitch: lerp(pose.gaze.pitch, look.pitch, look.mix) + life.dPitch,
      // Roll follows nothing: it is the state's own head tilt.
      roll: pose.gaze.roll + life.dRoll
    };

    // A state change blinks, on top of the calendar: upstream's trick for
    // hiding the instant a silhouette swaps.
    const forced = clamp((now - this.blinkAt) / 0.2);
    const forcedLid = forced < 1 ? Math.abs(forced * 2 - 1) : 1;
    const lid = Math.min(life.lid, forcedLid);

    const cx = pose.cx + life.driftX;
    const cy = pose.cy + life.driftY;

    const art = this.art;
    const head = { rot: pose.rot, sx: pose.sx, sy: pose.sy * life.breath, cx, cy };
    const bodyPath = closedPath(toPoints(art.head, head, RADIUS, this.body.head));
    const shift = (p) => ({ ...p, cx: p.cx + cx, cy: p.cy + cy });
    const earLPath = closedPath(
      toPoints(art.ear.l.profile, shift(earPose(-1, pose.ears.l, pose.rot, art)), RADIUS, this.body.earL)
    );
    const earRPath = closedPath(
      toPoints(art.ear.r.profile, shift(earPose(1, pose.ears.r, pose.rot, art)), RADIUS, this.body.earR)
    );

    const eyes = [];
    if (faceOn) {
      const poses = eyePoses(gaze, art.eye.split * pose.splitScale);
      for (let i = 0; i < 2; i++) {
        const e = poses[i];
        if (e.depth <= 0.02) continue;
        const cfg = pose.eyes[i];
        // The eye's own tilt composes with the sphere's tangent frame, which
        // is what allows the two eyes to lean in mirror.
        const phi = deg(cfg.tilt);
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        const ax = e.a * cp + e.c * sp;
        const ay = e.b * cp + e.d * sp;
        const bx = -e.a * sp + e.c * cp;
        const by = -e.b * sp + e.d * cp;
        // The blink is applied LAST: a vertical squash on screen, not along
        // the capsule's tilted axis.
        const k = blinkScale(Math.min(lid, cfg.open));
        eyes.push({
          d: capsulePath(cfg.w * art.eye.w * RADIUS, cfg.h * art.eye.h * RADIUS),
          matrix: `matrix(${r2(ax)},${r2(ay * k)},${r2(bx)},${r2(by * k)},` +
            `${r2((e.x + cx) * RADIUS)},${r2((e.y + cy + art.eye.y) * RADIUS)})`,
          alpha: pose.eyeAlpha * clamp(e.depth / 0.12)
        });
      }
    }

    // --- mouth ------------------------------------------------------------
    const mo = pose.mouth;
    const mouth = mo.alpha > 0.01
      ? {
          d: mouthPath(art.mouth.w * mo.w * RADIUS, art.mouth.h * RADIUS, mo.curve, mo.open),
          at: `translate(${r2((art.mouth.x + cx) * RADIUS)} ${r2((art.mouth.y + cy) * RADIUS)})`,
          alpha: mo.alpha
        }
      : null;

    return {
      glow: clamp(pose.glow + (alive ? Math.sin((now / 3.4) * TAU) * 0.08 : 0)),
      rainbow: clamp(pose.rainbow),
      tint: clamp(pose.tint),
      tintHue: ((pose.tintHue % 360) + 360) % 360,
      /** Degrees. One turn every 9 s, and a function of `now` like everything else. */
      spectrum: alive ? ((now * 40) % 360) : 0,
      bodyPath,
      mouth,
      earLPath,
      earRPath,
      eyes,
      glyphs: glyphFrame(pose.glyphs, alive ? now : 0),
      // The face glyphs ride the body drift; the outer marks stay put.
      faceShift: `translate(${r2(cx * RADIUS)} ${r2((cy + art.eye.y) * RADIUS)})`
    };
  }
}

/**
 * The glyphs this frame: how much of each is showing, and where it is.
 * A glyph the pose never mentions is left out rather than emitted at zero.
 */
function glyphFrame(amounts, t) {
  const out = {};
  for (const id in amounts) {
    const a = amounts[id];
    if (a <= 0.001) continue;
    const g = GLYPHS[id];
    const n = g.count ?? 1;
    for (let i = 0; i < n; i++) {
      const key = n === 1 ? id : `${id}#${i}`;
      const m = g.motion ? g.motion(t, i) : {};
      const o = clamp(a * (m.o ?? 1));
      // An instance at nothing is left out entirely: a tear between drops
      // should not be a node waiting to become one.
      if (o <= 0.004) continue;
      out[key] = { o, m: glyphTransform(key, t) };
    }
  }
  return out;
}

/** The resting frame, for baking a CSS-only snippet or a static export. */
export const restingPath = (state = "idle", art = PAW_ART) =>
  new PawEngine(state, art).sample(0, false).bodyPath;

/* -------------------------------------------------------------------- DOM */

let uid = 0;

/**
 * The SVG skeleton. With a `frame` it bakes that frame's geometry into the
 * markup, which is how snippet.html looks finished before any JS runs --
 * possible only because sample() is deterministic.
 *
 * Everything material comes from the drawing: its gradients, filters, sheen,
 * glints and ground stay in the drawing's own coordinates and are mapped in
 * by `art.m`. Nothing about the glass is hardcoded here, which is what lets
 * a different mascot bring a completely different look with it.
 *
 * The generator writes the drawing's def ids as bare tokens -- FILL and RIM
 * for whatever the head was filled and stroked with, D0.. for the rest --
 * and its own transform as %M%. Both get localised per instance, because two
 * avatars on one page must not share a def id.
 *
 * The lifted groups carry `fill="none"`, which is not decoration: an SVG root
 * is conventionally written `<svg fill="none">` and everything inside inherits
 * it, so a highlight stroked and never filled has no fill attribute of its
 * own. Lift that path out of its file without the context and it fills black,
 * which paints a dark shape exactly where the shine was. Reproducing the root
 * is what makes a drawing behave here as it does on its own.
 */
function template(id, frame, art) {
  const gid = (k) => `fx-paw-${k.toLowerCase()}-${id}`;
  const localise = (svg) =>
    svg
      .split("%M%").join(art.m)
      .replace(/\b(FILL|RIM|D\d+)\b/g, (k) => gid(k));

  const at = (i, k, dflt) => (frame ? (frame.eyes[i] ? frame.eyes[i][k] : dflt) : dflt);
  // Only what this frame actually shows. Every glyph used to be emitted at
  // opacity 0 and left there, which is thirteen groups per avatar that paint
  // nothing -- and the floor glow already taught us that invisible is not the
  // same as absent. draw() adds and removes them from here on.
  const shown = frame ? Object.keys(frame.glyphs) : [];
  const glyph = (k) => glyphMarkup(k, frame.glyphs[k]);
  // Routed by a flag, not by a name: whether a mark rides the face is a fact
  // about the mark, and a naming convention is a fact about nothing.
  const marks = shown.filter((k) => !GLYPHS[baseOf(k)].onFace && !GLYPHS[baseOf(k)].behind).map(glyph).join("");
  const faces = shown.filter((k) => GLYPHS[baseOf(k)].onFace).map(glyph).join("");
  const backs = shown.filter((k) => GLYPHS[baseOf(k)].behind).map(glyph).join("");
  const d = frame ? frame.bodyPath : "";
  const eL = frame ? frame.earLPath : "";
  const eR = frame ? frame.earRPath : "";
  const shift = frame ? frame.faceShift : "";
  const eye = (i) =>
    `<g class="fx-paw-eye" transform="${at(i, "matrix", "")}" opacity="${at(i, "alpha", 0)}">` +
    `<path d="${at(i, "d", "")}"/>` +
    `<circle class="fx-paw-catch" cx="${r2(art.catch.x)}" cy="${r2(art.catch.y)}" r="${r2(art.catch.r)}"/></g>`;

  // One glass part = the drawn fill, then the drawn rim on top, then the
  // spectrum rim the creative state fades up. The body additionally clips
  // the drawing's sheen to its outline so it never spills when a state
  // squashes or tilts it.
  const part = (key, dd, extra = "") => `
  <g class="fx-paw-part">
    <clipPath id="fx-paw-clip-${key}-${id}"><path data-part="${key}" d="${dd}"/></clipPath>
    <path class="fx-paw-fill" data-part="${key}" d="${dd}" fill="url(#${gid("FILL")})"/>${extra ? `
    <g clip-path="url(#fx-paw-clip-${key}-${id})">${extra}</g>` : ""}
    <path class="fx-paw-rim" data-part="${key}" d="${dd}" fill="none" stroke="url(#${gid("RIM")})"/>
  </g>`;

  return `<div class="fx-paw"><svg class="fx-paw-svg" viewBox="${-art.box} ${-art.box} ${art.box * 2} ${art.box * 2}" aria-hidden="true" focusable="false">
  <defs>
    ${localise(art.art.glass.fill)}
    ${localise(art.art.glass.rim)}
    ${localise(art.art.glass.defs)}
    <linearGradient id="fx-paw-spectrum-${id}" class="fx-paw-spectrum-def" x1="-110" y1="0" x2="110" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff5d7a"/>
      <stop offset="0.17" stop-color="#ffb03a"/>
      <stop offset="0.34" stop-color="#8bff7a"/>
      <stop offset="0.5" stop-color="#48e5ff"/>
      <stop offset="0.67" stop-color="#7f8cff"/>
      <stop offset="0.84" stop-color="#e070ff"/>
      <stop offset="1" stop-color="#ff5d7a"/>
    </linearGradient>
  </defs>
  <g class="fx-paw-ground" fill="none" transform="${art.m}">${localise(art.art.glass.ground)}</g>
  <g class="fx-paw-back">${backs}</g>
  ${part("earL", eL)}
  ${part("earR", eR)}
  ${part("body", d, `<g fill="none" transform="${art.m}">${localise(art.art.glass.sheen)}</g>`)}
  <g class="fx-paw-mouth">${frame && frame.mouth
    ? `<path d="${frame.mouth.d}" transform="${frame.mouth.at}" opacity="${r2(frame.mouth.alpha)}"/>`
    : ""}</g>
  <g class="fx-paw-face" transform="${shift}">
    ${eye(0)}
    ${eye(1)}
    ${faces}
  </g>
  <g class="fx-paw-marks">${marks}</g>
</svg></div>`;
}

/**
 * Render one avatar into `el`.
 *
 * opts.state   one of STATE_IDS (default "idle")
 * opts.speed   time multiplier, 0.1-10
 * opts.cycle   seconds per state when walking every state; 0 = hold one state
 */
export function mount(el, opts = {}) {
  // A site generator loops querySelectorAll and mounts what it finds; one
  // throw here takes the rest of the page's effects with it.
  if (!el) return { update() {}, destroy() {} };
  // The host mounts from snippet.html with no options, so the data-* on the
  // element is the only configuration channel a generated site has.
  const ds = el.dataset ?? {};
  const o = {
    state: ds.fxState ?? "idle",
    speed: ds.fxSpeed ?? 1,
    track: ds.fxTrack !== "false",
    // An explicit state wins over the showcase carousel: a site that asks for
    // "thinking" means it, and the snippet ships with both attributes.
    cycle: ds.fxState ? 0 : ds.fxCycle ?? 0,
    /**
     * Draws per second. 0 means every frame the browser offers.
     *
     * Sixty is right for a hero somebody is looking at. It is wasteful for a
     * mascot idling in the corner of a desktop: measured on a Tauri window,
     * drawing the resting Paw at 60 cost about 9% of a core, and almost all
     * of that is breathing and drift nobody can see at half the rate.
     */
    fps: Number(ds.fxFps ?? 0) || 0,
    /** A point in the mood space, "valence,arousal,attention", instead of a state. */
    mood: ds.fxMood ?? "",
    /** The drawing. Pass a different one and you get a different mascot. */
    art: PAW_ART,
    ...opts
  };
  const still = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The wrapper carries the sizing, so mount() works on any host element --
  // the snippet's section, or a bare <span> in a chat bubble.
  const restore = el.innerHTML;
  const engineArt = compileArt(o.art);
  el.innerHTML = template(++uid, null, engineArt);

  const svg = el.querySelector(".fx-paw-svg");
  const wrap = svg.parentElement;
  const parts = {
    body: svg.querySelectorAll('[data-part="body"]'),
    earL: svg.querySelectorAll('[data-part="earL"]'),
    earR: svg.querySelectorAll('[data-part="earR"]')
  };
  const eyeEls = svg.querySelectorAll(".fx-paw-eye");
  /** id -> the node currently showing it. Empty until a frame asks. */
  const glyphEls = {};
  for (const g of svg.querySelectorAll(".fx-paw-glyph")) glyphEls[g.dataset.g] = g;
  const face = svg.querySelector(".fx-paw-face");
  const marks = svg.querySelector(".fx-paw-marks");
  const back = svg.querySelector(".fx-paw-back");
  const mouthHost = svg.querySelector(".fx-paw-mouth");
  let mouthEl = mouthHost.firstElementChild;
  const spectrum = svg.querySelector(".fx-paw-spectrum-def");
  const spectrumRef = `url(#${spectrum.id})`;
  const PART_KEYS = ["body", "earL", "earR"];
  /** part -> its alt rim node, while one exists. */
  const altRims = {};

  /** "0.2,0.8,0.5" or {valence,arousal,attention}; anything else is no mood. */
  const asMood = (m) => {
    if (!m) return null;
    if (typeof m === "object") return m;
    const n = String(m).split(",").map(Number);
    if (n.length !== 3 || !n.every(Number.isFinite)) return null;
    return { valence: n[0], arousal: n[1], attention: n[2] };
  };

  const engine = new PawEngine(o.state, o.art);
  const mood0 = asMood(o.mood);
  if (mood0) engine.setMood(mood0, 0);
  let raf = 0;
  // Seeded here, not on the first frame: update() can be called before rAF has
  // run, and a t0 of 0 would date that change hundreds of seconds in the
  // future, leaving the avatar stuck on its initial state until wall clock
  // caught up. rAF timestamps share performance.now()'s origin.
  let t0 = typeof performance === "object" ? performance.now() : 0;
  let cycleAt = 0;
  let cycleAt0 = 0;
  /* Last sampled time, so a pointer move dates its look without reading a
   * second clock. A frame old at most, which is below the catch-up time. */
  let clock = 0;
  /** When the last draw went out, for the fps cap. */
  let lastDraw = -1e9;

  const speed = () => clamp(Number(o.speed) || 1, 0.1, 10);

  function draw(now) {
    const f = engine.sample(now, !still);
    wrap.style.setProperty("--fx-paw-pulse", r2(f.glow));
    wrap.style.setProperty("--fx-paw-rainbow", r2(f.rainbow));
    // Rotating the gradient rather than recolouring the stops: the travel is
    // one attribute, and the stops loop so the seam never shows.
    if (f.rainbow > 0.01) spectrum.setAttribute("gradientTransform", `rotate(${r2(f.spectrum)})`);

    // The second rim exists only while something is using it. One layer
    // serves both the spectrum and a flat tint, because they are the same
    // thing -- a rim that is not the drawing's -- and two layers would mean
    // one of them idling in every avatar that wants neither.
    const alt = Math.max(f.rainbow, f.tint);
    for (const key of PART_KEYS) {
      let el = altRims[key];
      if (alt <= 0.01) {
        if (el) {
          el.remove();
          delete altRims[key];
        }
        continue;
      }
      if (!el) {
        // The first [data-part] node is the clipPath's copy of the outline,
        // so its parent is the <clipPath> -- and a path inserted in there is
        // a mask, not a picture. It went in there once, and the rainbow
        // vanished while every id still resolved. The part group is what we
        // want, and closest() is what finds it.
        const host = parts[key][0].closest(".fx-paw-part");
        host.insertAdjacentHTML("beforeend", `<path class="fx-paw-rim-alt" d=""/>`);
        el = host.lastElementChild;
        altRims[key] = el;
      }
      el.setAttribute("d", key === "body" ? f.bodyPath : key === "earL" ? f.earLPath : f.earRPath);
      if (f.rainbow >= f.tint) {
        // the spectrum is an outline only; the glass underneath stays the drawing's
        el.setAttribute("stroke", spectrumRef);
        el.setAttribute("fill", "none");
        el.setAttribute("opacity", r2(f.rainbow));
      } else {
        // A tint is the glass itself changing colour, so it is a FILL as well
        // as a rim. The fill is deep and the rim is bright, which is how lit
        // glass looks: the body soaks the colour, the edge catches the light.
        const h = r2(f.tintHue);
        el.setAttribute("stroke", `hsl(${h} 92% 70%)`);
        el.setAttribute("fill", `hsl(${h} 80% 40%)`);
        el.setAttribute("fill-opacity", r2(0.42 * f.tint));
        el.setAttribute("opacity", r2(f.tint));
      }
    }
    wrap.style.setProperty("--fx-paw-alt-rim", r2(alt));
    if (f.tint > 0.01) {
      const h = r2(f.tintHue);
      // the bloom and the floor follow the glass
      wrap.style.setProperty("--fx-paw-glow", `hsl(${h} 90% 58% / ${r2(0.3 + 0.35 * f.tint)})`);
      wrap.style.setProperty("--fx-paw-halo", `hsl(${h} 85% 60%)`);
      wrap.style.setProperty("--fx-paw-floor-a", `hsl(${h} 85% 72%)`);
    } else {
      wrap.style.removeProperty("--fx-paw-glow");
      wrap.style.removeProperty("--fx-paw-halo");
      wrap.style.removeProperty("--fx-paw-floor-a");
    }
    for (const p of parts.body) p.setAttribute("d", f.bodyPath);
    for (const p of parts.earL) p.setAttribute("d", f.earLPath);
    for (const p of parts.earR) p.setAttribute("d", f.earRPath);
    face.setAttribute("transform", f.faceShift);
    for (let i = 0; i < eyeEls.length; i++) {
      const e = f.eyes[i];
      if (!e) {
        eyeEls[i].setAttribute("opacity", "0");
        continue;
      }
      eyeEls[i].firstChild.setAttribute("d", e.d);
      eyeEls[i].setAttribute("transform", e.matrix);
      eyeEls[i].setAttribute("opacity", r2(e.alpha));
    }
    // The mouth is absent until a state opens one, and gone again after. The
    // Paw is drawn without one, so for most states this is no node at all.
    if (f.mouth) {
      if (!mouthEl) {
        mouthHost.insertAdjacentHTML("beforeend", `<path d="" />`);
        mouthEl = mouthHost.lastElementChild;
      }
      mouthEl.setAttribute("d", f.mouth.d);
      mouthEl.setAttribute("transform", f.mouth.at);
      mouthEl.setAttribute("opacity", r2(f.mouth.alpha));
    } else if (mouthEl) {
      mouthEl.remove();
      mouthEl = null;
    }

    // Reconcile: a glyph the frame does not mention is REMOVED, not hidden.
    // The set changes only when a state does, so this is a couple of DOM
    // writes on a transition and none at all in between.
    for (const k in f.glyphs) {
      let el = glyphEls[k];
      if (!el) {
            const g = GLYPHS[baseOf(k)];
        const into = g.onFace ? face : g.behind ? back : marks;
        into.insertAdjacentHTML("beforeend", glyphMarkup(k, f.glyphs[k]));
        el = into.lastElementChild;
        glyphEls[k] = el;
      }
      el.setAttribute("opacity", r2(f.glyphs[k].o));
      el.setAttribute("transform", f.glyphs[k].m);
    }
    for (const k in glyphEls) {
      if (f.glyphs[k]) continue;
      glyphEls[k].remove();
      delete glyphEls[k];
    }
  }

  function frame(ts) {
    const now = ((ts - t0) / 1000) * speed();
    clock = now;
    const every = Number(o.cycle) || 0;
    if (every > 0 && now - cycleAt0 >= every) {
      cycleAt0 = now;
      cycleAt = (cycleAt + 1) % STATE_IDS.length;
      engine.setState(STATE_IDS[cycleAt], now);
    }
    // The clock always advances; only the DRAWING is rationed. A capped
    // avatar is not a slower one -- sample(t) is a function of time, so it
    // shows the right frame for the moment it is drawn, just less often.
    const cap = Number(o.fps) || 0;
    if (onScreen && (!cap || ts - lastDraw >= 1000 / cap - 1)) {
      lastDraw = ts;
      draw(now);
    }
    raf = requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------ tracking
   * How far the gaze travels at the edge of its reach, degrees. Past that
   * the tanh saturates, so a pointer on the far side of the page and one
   * just outside the avatar ask for nearly the same look. */
  const MAX_YAW = 27;
  const MAX_PITCH = 17;
  /* Reach, in avatar widths from its centre. */
  const REACH = 1.8;

  let released = true;
  /* Pointer speed, for the startle. Kept here and not in the engine: the
   * engine is told WHAT happened, never asked to work it out from raw input. */
  let lastMove = null;
  let lastStartle = -10;
  /** px/ms that counts as sudden. A brisk drag is ~1.5; a flung pointer ~4. */
  const STARTLE_SPEED = 2.6;
  /** A startle every frame would be a twitch, not a reaction. */
  const STARTLE_GAP = 1.4;

  const onMove = (e) => {
    // Touch has no hovering pointer: a tap would yank the gaze and leave it.
    if (e.pointerType && e.pointerType !== "mouse") return;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (lastMove) {
      const dt = Math.max(1, clock * 1000 - lastMove.t);
      const speed = Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / dt;
      if (speed > STARTLE_SPEED && clock - lastStartle > STARTLE_GAP) {
        engine.react("startle", clock, clamp((speed - STARTLE_SPEED) / 4));
        lastStartle = clock;
      }
    }
    lastMove = { x: e.clientX, y: e.clientY, t: clock * 1000 };

    const nx = (e.clientX - (r.left + r.width / 2)) / (r.width * REACH);
    const ny = (e.clientY - (r.top + r.height / 2)) / (r.height * REACH);
    engine.setLook(
      {
        yaw: MAX_YAW * Math.tanh(nx * 2),
        // screen y grows downward, pitch grows upward
        pitch: -MAX_PITCH * Math.tanh(ny * 2),
        mix: 1,
        wander: 0.15
      },
      clock
    );
    released = false;
  };

  const onRelease = () => {
    engine.setHover(false, clock);
    if (released) return;
    engine.setLook(null, clock, 0.6);
    released = true;
  };

  // Poking and hovering are about the mascot itself, so they sit on the
  // element; tracking and the startle are about the pointer anywhere, so
  // those sit on the window.
  const onDown = () => engine.react("poke", clock);
  const onEnter = () => engine.setHover(true, clock);
  const onOut = () => engine.setHover(false, clock);

  const tracking = o.track && !still && typeof window !== "undefined";
  if (tracking) {
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("blur", onRelease);
    document.addEventListener("pointerleave", onRelease);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onOut);
  }

  /*
   * Off-screen avatars keep their clock and stop writing to the DOM.
   *
   * The clock has to keep running: sample(t) is a function of time, and a
   * paused one would scroll back into view frozen in the past and then snap.
   * What is skipped is the writing, which is all an unseen avatar was ever
   * contributing. A page with one of these pays nothing for it; a page with
   * fifty pays for the few you can actually see.
   */
  let onScreen = true;
  let watcher = null;
  if (!still && typeof IntersectionObserver === "function") {
    watcher = new IntersectionObserver(
      ([entry]) => { onScreen = entry.isIntersecting; },
      { rootMargin: "120px" }
    );
    watcher.observe(el);
  }

  if (still) draw(0);
  else raf = requestAnimationFrame(frame);

  return {
    /** The engine, for anything the pointer wiring does not cover. */
    engine,
    /** Engine time now, which is what its dated setters expect. */
    clock: () => clock,
    update(next = {}) {
      Object.assign(o, next);
      if ("mood" in next) {
        const m = asMood(next.mood);
        const now = still ? 0 : ((performance.now() - t0) / 1000) * speed();
        if (m) engine.setMood(m, now);
        else engine.setState(o.state ?? "idle", now);
        if (still) draw(0);
      }
      if (next.state && next.state !== engine.state) {
        // Reduced motion holds no clock, so a change there lands whole.
        const now = still ? 0 : (performance.now() - t0) / 1000 * speed();
        if (still) engine.reset(next.state, 0);
        else engine.setState(next.state, now);
        cycleAt = Math.max(0, STATE_IDS.indexOf(engine.state));
        cycleAt0 = now;
        if (still) draw(0);
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      if (watcher) watcher.disconnect();
      if (tracking) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("blur", onRelease);
        document.removeEventListener("pointerleave", onRelease);
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointerenter", onEnter);
        el.removeEventListener("pointerleave", onOut);
      }
      el.innerHTML = restore;
    }
  };
}

/** Static markup for one state: snippet.html, and any still export. */
export const restingMarkup = (state = "idle", id = "s", art = PAW_ART) => {
  const e = new PawEngine(state, art);
  return template(id, e.sample(0, false), e.art);
};

export const meta = {
  name: "paw-avatar",
  version: "1.0.0",
  category: "character",
  needs: [],
  license: "MIT",
  options: {
    state: { type: "string", default: "idle", description: "Which state to hold. One of idle, happy, excited, curious, thinking, working, focused, surprised, sleeping, wink, confused, sad, love, celebrating, creative, awkward, annoyed, gloomy, dizzy, starstruck, crying, overheated, firedUp, powering, shocked, smug, deadpan, listening." },
    speed: { type: "number", default: 1, description: "Time multiplier for the whole engine. Clamped to 0.1-10." },
    cycle: { type: "number", default: 0, description: "Seconds per state when walking every state in turn; 0 holds the chosen state." },
    fps: { type: "number", default: 0, description: "Cap how often it redraws. 0 draws every frame the browser offers; 30 halves the work for a mascot nobody is staring at, and the animation is unchanged because the pose is a function of time." },
    mood: { type: "string", default: "", description: "A point in the mood space instead of a named state: \"valence,arousal,attention\", each -1..1, 0..1, 0..1. Empty means use the state." },
    track: { type: "boolean", default: true, description: "Follow the mouse pointer with the gaze. Set data-fx-track=\"false\" to hold the state's own gaze." }
  }
};
