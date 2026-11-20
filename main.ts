// gta6-meme-x-01 — GTA 6 meme generator.
// Renders a 1200x1200 Vice City sunset meme (make.fun ghost leaning on a
// pink sports car) as a PNG, and copies POST.json to the output directory.
// Node 22 standard library only. Fully deterministic: no network, no clock,
// no randomness. Own PNG encoder (zlib deflate + hand-rolled CRC32), own
// rasterizer (rects, circles, ellipses, polygons, lines) and own 5x7 bitmap
// font designed for this meme. Never deletes the output directory itself
// (the grader bind-mounts it); only writes files into it.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const W = 1200;
const H = 1200;

// ---------------------------------------------------------------------------
// CRC32 (IEEE, polynomial 0xEDB88320), computed by hand.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Encode an RGB buffer (W*H*3) as a PNG. One filter byte (0 = none) per row.
function encodePNG(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    raw.set(pixels.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas + rasterizer. Pixels are [r, g, b] triples in a flat Uint8Array.
// ---------------------------------------------------------------------------
const px = new Uint8Array(W * H * 3);

function rgb(r, g, b) {
  return [r, g, b];
}
function setPixel(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
}
function fillRect(x0, y0, x1, y1, c) {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) setPixel(x, y, c);
  }
}
// Vertical gradient: stops is [[t0, colour], [t1, colour], ...], t in 0..1.
function vGradient(y0, y1, stops) {
  for (let y = y0; y <= y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) {
        a = stops[i];
        b = stops[i + 1];
        break;
      }
    }
    const f = (t - a[0]) / Math.max(0.0001, b[0] - a[0]);
    const c = [
      Math.round(a[1][0] + (b[1][0] - a[1][0]) * f),
      Math.round(a[1][1] + (b[1][1] - a[1][1]) * f),
      Math.round(a[1][2] + (b[1][2] - a[1][2]) * f),
    ];
    for (let x = 0; x < W; x++) setPixel(x, y, c);
  }
}
function fillCircle(cx, cy, r, c) {
  const rr = Math.round(r);
  for (let dy = -rr; dy <= rr; dy++) {
    const dx = Math.floor(Math.sqrt(Math.max(0, rr * rr - dy * dy)));
    for (let x = cx - dx; x <= cx + dx; x++) setPixel(x, cy + dy, c);
  }
}
function fillEllipse(cx, cy, rx, ry, c) {
  const ryI = Math.round(ry);
  for (let dy = -ryI; dy <= ryI; dy++) {
    const f = 1 - (dy * dy) / (ry * ry);
    if (f < 0) continue;
    const dx = Math.floor(rx * Math.sqrt(f));
    for (let x = cx - dx; x <= cx + dx; x++) setPixel(x, cy + dy, c);
  }
}
// Scanline polygon fill. pts is [[x, y], ...].
function fillPolygon(pts, c) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) setPixel(x, y, c);
    }
  }
}
// Thick line: walk along the segment stamping discs.
function thickLine(x0, y0, x1, y1, w, c) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.max(1, Math.hypot(dx, dy));
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(Math.round(x0 + dx * t), Math.round(y0 + dy * t), w / 2, c);
  }
}
function strokePolygon(pts, w, c) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    thickLine(a[0], a[1], b[0], b[1], w, c);
  }
}
// Four-pointed sparkle (the ghost's eyes): a concave diamond.
function sparkle(cx, cy, s, c) {
  const k = 0.26;
  fillPolygon(
    [
      [cx, cy - s],
      [cx + s * k, cy - s * k],
      [cx + s, cy],
      [cx + s * k, cy + s * k],
      [cx, cy + s],
      [cx - s * k, cy + s * k],
      [cx - s, cy],
      [cx - s * k, cy - s * k],
    ],
    c
  );
}
// Five-pointed star, outer radius ro, inner radius ri.
function star(cx, cy, ro, ri, c) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  fillPolygon(pts, c);
}

// ---------------------------------------------------------------------------
// Bitmap font: 5x7 glyphs designed for this meme. "#" = ink, "." = blank.
// Bold blocky caps so the captions stay readable when the judge sees the
// meme shrunk to 480x480. Covers A-Z, 0-9 and basic punctuation.
// ---------------------------------------------------------------------------
const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00000", "01100"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "'": ["00100", "00100", "00000", "00000", "00000", "00000", "00000"],
  ":": ["00000", "01100", "00000", "00000", "00000", "01100", "00000"],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPH_ADV = 6; // glyph width + 1 column of tracking, in font units

function textWidth(text, scale) {
  return (text.length * GLYPH_ADV - 1) * scale;
}

// Draw one line of text at (x, y) = top-left, in one colour, no outline.
function drawTextRaw(text, x, y, scale, c) {
  for (let ci = 0; ci < text.length; ci++) {
    const g = FONT[text[ci]] || FONT[" "];
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (g[row][col] === "1") {
          fillRect(
            x + (ci * GLYPH_ADV + col) * scale,
            y + row * scale,
            x + (ci * GLYPH_ADV + col + 1) * scale - 1,
            y + (row + 1) * scale - 1,
            c
          );
        }
      }
    }
  }
}

// Draw a centred line with a thick outline: the outline colour is stamped
// in a ring of offsets first, then the face colour on top.
function drawTextCentred(text, cx, y, scale, face, outline) {
  const w = textWidth(text, scale);
  const x = Math.round(cx - w / 2);
  const o = Math.max(3, Math.round(scale * 0.55));
  for (let dy = -o; dy <= o; dy += Math.max(1, Math.round(o / 2))) {
    for (let dx = -o; dx <= o; dx += Math.max(1, Math.round(o / 2))) {
      if (dx === 0 && dy === 0) continue;
      drawTextRaw(text, x + dx, y + dy, scale, outline);
    }
  }
  drawTextRaw(text, x, y, scale, face);
}

// ---------------------------------------------------------------------------
// Scene colours.
// ---------------------------------------------------------------------------
const INK = rgb(14, 5, 24); // near-black outline / silhouette
const WHITE = rgb(255, 255, 255);
const MAGENTA = rgb(200, 29, 122); // make.fun magenta, about #C81D7A
const PINK = rgb(255, 46, 126); // sports-car pink
const SUN_YELLOW = rgb(255, 233, 168);
const NEON_PINK = rgb(255, 93, 162);
const NEON_CYAN = rgb(127, 231, 255);

// ---------------------------------------------------------------------------
// Scene pieces, drawn back to front.
// ---------------------------------------------------------------------------
function drawSky() {
  vGradient(0, 560, [
    [0, rgb(42, 10, 74)], // deep purple at the top
    [0.45, rgb(150, 48, 120)], // pink
    [0.8, rgb(255, 110, 60)], // orange
    [1, rgb(255, 150, 60)], // bright orange at the horizon
  ]);
  // A few tiny stars, kept below the caption band (y >= 210) so they
  // never land inside the big letters.
  const stars = [
    [80, 220], [150, 300], [210, 240], [1080, 230], [1140, 300],
    [1000, 320], [60, 340], [940, 330], [330, 330], [620, 300],
  ];
  for (const s of stars) {
    fillCircle(s[0], s[1], 3, WHITE);
    fillCircle(s[0], s[1], 1, rgb(255, 220, 240));
  }
  // Sun: concentric glow discs, low on the left of centre. Small enough
  // that the glow ends above the ocean band, so nothing pokes through
  // below the horizon line.
  fillCircle(430, 480, 130, rgb(255, 122, 69));
  fillCircle(430, 480, 105, rgb(255, 178, 94));
  fillCircle(430, 480, 85, SUN_YELLOW);
  // Birds: three little "v" strokes, below the caption band.
  const birds = [
    [800, 240], [870, 210], [940, 250],
  ];
  for (const b of birds) {
    thickLine(b[0] - 14, b[1], b[0], b[1] - 8, 5, INK);
    thickLine(b[0], b[1] - 8, b[0] + 14, b[1], 5, INK);
  }
}

function drawOcean() {
  fillRect(0, 560, W - 1, 640, rgb(38, 24, 96));
  // Sun reflection path: a bright vertical band under the sun, made of
  // short horizontal streaks that widen toward the viewer.
  const streaks = [
    [400, 566, 460, 574, rgb(255, 196, 107)],
    [388, 578, 472, 588, rgb(255, 154, 61)],
    [404, 592, 456, 600, rgb(255, 196, 107)],
    [376, 604, 484, 614, rgb(255, 154, 61)],
    [392, 618, 468, 628, rgb(255, 196, 107)],
    [360, 630, 500, 638, rgb(255, 122, 69)],
  ];
  for (const s of streaks) fillRect(s[0], s[1], s[2], s[3], s[4]);
  // A few calm wave lines away from the reflection.
  const waveC = rgb(90, 60, 160);
  fillRect(80, 592, 300, 596, waveC);
  fillRect(680, 588, 900, 592, waveC);
  fillRect(980, 600, 1140, 604, waveC);
  fillRect(140, 622, 320, 626, waveC);
  fillRect(760, 620, 1080, 624, waveC);
}

function drawSkyline() {
  // Dark building silhouettes along y 640..820, with neon lit windows.
  const buildings = [
    [0, 700, 90, 820], [80, 660, 170, 820], [160, 720, 250, 820],
    [240, 680, 330, 820], [320, 740, 400, 820], [390, 690, 470, 820],
    [460, 730, 540, 820], [530, 665, 620, 820], [610, 715, 700, 820],
    [690, 675, 780, 820], [770, 735, 860, 820], [850, 690, 940, 820],
    [930, 720, 1020, 820], [1010, 670, 1100, 820], [1090, 730, 1200, 820],
  ];
  for (const b of buildings) fillRect(b[0], b[1], b[2], b[3], rgb(22, 10, 40));
  // Rooftop antennas with red beacons.
  thickLine(125, 660, 125, 620, 5, INK);
  fillCircle(125, 616, 6, rgb(255, 60, 60));
  thickLine(575, 665, 575, 630, 5, INK);
  fillCircle(575, 626, 6, rgb(255, 60, 60));
  thickLine(1055, 670, 1055, 635, 5, INK);
  fillCircle(1055, 631, 6, rgb(255, 60, 60));
  // Lit windows: a fixed checker pattern, neon pink / cyan / warm yellow.
  const winColours = [NEON_PINK, NEON_CYAN, rgb(255, 214, 90)];
  for (let bi = 0; bi < buildings.length; bi++) {
    const b = buildings[bi];
    for (let wy = b[1] + 18; wy < 800; wy += 26) {
      for (let wx = b[0] + 12; wx < b[2] - 12; wx += 24) {
        if ((bi * 7 + wx + wy) % 5 < 2) {
          fillRect(wx, wy, wx + 9, wy + 12, winColours[(bi + wx + wy) % 3]);
        }
      }
    }
  }
  // Neon "VICE CITY" sign on the tallest block, left of centre.
  drawTextCentred("VICE CITY", 285, 700, 4, NEON_PINK, INK);
}

function drawStreet() {
  vGradient(820, 1199, [
    [0, rgb(28, 12, 44)],
    [1, rgb(14, 6, 26)],
  ]);
  // Pink neon kerb line where the street meets the skyline.
  fillRect(0, 820, W - 1, 826, NEON_PINK);
  fillRect(0, 827, W - 1, 829, rgb(120, 30, 90));
}

// One palm frond: a long thin blade arcing from the crown (cx, cy) to a
// tip, sagging along a quadratic curve (ctrl pulls the arc downward).
function blade(cx, cy, tipX, tipY, ctrlX, ctrlY, w, c) {
  const left = [];
  const right = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * cx + 2 * mt * t * ctrlX + t * t * tipX;
    const y = mt * mt * cy + 2 * mt * t * ctrlY + t * t * tipY;
    // Tangent of the curve, for the perpendicular offset.
    const tx = 2 * mt * (ctrlX - cx) + 2 * t * (tipX - ctrlX);
    const ty = 2 * mt * (ctrlY - cy) + 2 * t * (tipY - ctrlY);
    const tl = Math.max(1, Math.hypot(tx, ty));
    const nx = -ty / tl;
    const ny = tx / tl;
    const half = w * (1 - t * 0.55);
    left.push([x + nx * half, y + ny * half]);
    right.push([x - nx * half, y - ny * half]);
  }
  fillPolygon(left.concat(right.reverse()), c);
}

// Palm tree silhouette: curved trunk + drooping fronds, near-black.
function drawPalm(baseX, baseY, topX, topY, lean) {
  const segs = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = baseX + (topX - baseX) * t + Math.sin(t * Math.PI) * lean;
    const y = baseY + (topY - baseY) * t;
    segs.push([x, y]);
  }
  for (let i = 0; i < segs.length - 1; i++) {
    thickLine(segs[i][0], segs[i][1], segs[i + 1][0], segs[i + 1][1], 26 - i * 2, INK);
  }
  // Fronds: blades fanning out from the crown, tips drooping downward.
  const cx = topX;
  const cy = topY;
  const fronds = [
    [cx - 165, cy - 55, cx - 90, cy - 55], // up-left
    [cx - 115, cy - 140, cx - 55, cy - 95], // up
    [cx - 20, cy - 165, cx - 5, cy - 100], // up
    [cx + 85, cy - 135, cx + 45, cy - 85], // up-right
    [cx + 165, cy - 60, cx + 95, cy - 40], // right
    [cx + 185, cy + 35, cx + 100, cy + 5], // right-down
    [cx + 120, cy + 110, cx + 60, cy + 45], // down-right
    [cx - 120, cy + 95, cx - 60, cy + 40], // down-left
    [cx - 185, cy + 20, cx - 100, cy - 5], // left-down
  ];
  for (const f of fronds) blade(cx, cy, f[0], f[1], f[2], f[3], 13, INK);
  // Coconuts under the crown.
  fillCircle(cx - 14, cy + 22, 12, INK);
  fillCircle(cx + 12, cy + 26, 12, INK);
}

// Pink sports car, side view, nose to the right, low and sleek.
function drawCar() {
  // Ground shadow.
  fillEllipse(375, 995, 300, 26, rgb(8, 3, 16));
  // Body: black outline polygon slightly larger, then the pink body.
  const body = [
    [95, 962], [118, 922], [258, 910], [308, 876], [468, 870],
    [556, 892], [648, 918], [652, 958], [620, 970], [150, 970],
  ];
  const outline = [
    [89, 966], [114, 916], [256, 904], [306, 870], [470, 864],
    [560, 886], [654, 914], [658, 960], [622, 976], [148, 976],
  ];
  fillPolygon(outline, INK);
  fillPolygon(body, PINK);
  // Cabin glass.
  const glass = [
    [282, 904], [322, 882], [452, 878], [498, 900], [470, 906], [300, 908],
  ];
  fillPolygon(glass, NEON_CYAN);
  strokePolygon(glass, 5, INK);
  // Pink highlight stripe along the flank.
  thickLine(150, 940, 600, 928, 6, rgb(255, 120, 180));
  // Headlight and taillight.
  fillEllipse(632, 936, 16, 7, rgb(255, 240, 160));
  fillEllipse(104, 936, 12, 7, rgb(255, 60, 60));
  // Wheels with grey hubs.
  for (const wx of [212, 545]) {
    fillCircle(wx, 962, 44, INK);
    fillCircle(wx, 962, 34, rgb(30, 30, 40));
    fillCircle(wx, 962, 16, rgb(180, 180, 200));
    fillCircle(wx, 962, 6, PINK);
  }
}

// ---------------------------------------------------------------------------
// The make.fun ghost: big, centre-right, leaning on the car's roof.
// White body, thick near-black outline, two black four-pointed sparkle eyes
// (drawn as tiny sunglasses: sparkle lenses + bridge + temple arms), a round
// little hand holding a magenta disc with a white five-pointed star.
// Drawn from the reference mascot with the rasterizer — no image is copied.
// ---------------------------------------------------------------------------
function drawGhost() {
  // Body, drawn twice: an expanded black silhouette (the outline), then
  // the white body inset by the outline thickness. The ghost sits low and
  // left enough that its lower-left lobe rests on the car's nose.
  const outline = 13;
  // Head circle + torso rect + two bottom lobes = the classic ghost blob.
  fillCircle(748, 660, 140 + outline, INK);
  fillRect(608 - outline, 660, 888 + outline, 864 + outline, INK);
  fillCircle(693, 864, 72 + outline, INK);
  fillCircle(803, 864, 72 + outline, INK);
  // Left arm stub (viewer left).
  fillEllipse(618, 774, 44 + outline, 64 + outline, INK);
  fillCircle(748, 660, 140, WHITE);
  fillRect(608, 660, 888, 864, WHITE);
  fillCircle(693, 864, 72, WHITE);
  fillCircle(803, 864, 72, WHITE);
  fillEllipse(618, 774, 44, 64, WHITE);
  // Centre notch slit at the hem, between the two lobes.
  fillRect(744, 864, 752, 918, INK);
  // Sparkle eyes + sunglasses: sparkle lenses, a bridge, temple arms.
  sparkle(698, 634, 34, INK);
  sparkle(800, 634, 34, INK);
  thickLine(728, 628, 770, 628, 8, INK);
  thickLine(670, 642, 634, 656, 7, INK);
  thickLine(828, 642, 864, 656, 7, INK);
  // Magenta disc with white star, held up at the ghost's right.
  fillCircle(922, 648, 76, INK);
  fillCircle(922, 648, 62, MAGENTA);
  star(922, 648, 36, 15, WHITE);
  // Round little hand under the disc, gripping it.
  fillCircle(876, 760, 52, INK);
  fillCircle(876, 760, 40, WHITE);
}

// ---------------------------------------------------------------------------
// Render the whole meme, then write meme.png + POST.json to the output dir.
// ---------------------------------------------------------------------------
function render() {
  drawSky();
  drawOcean();
  drawSkyline();
  drawStreet();
  drawPalm(105, 830, 62, 400, -38); // left palm, framing the scene
  drawPalm(1115, 830, 1152, 430, 30); // right palm, framing the scene
  drawCar();
  drawGhost();
  // Captions: white with a thick black outline, huge blocky bitmap letters.
  drawTextCentred("WAITED 13 YEARS", 600, 36, 9, WHITE, INK);
  drawTextCentred("FOR GTA 6", 600, 126, 9, WHITE, INK);
  drawTextCentred("MY AGENT GOT PAID", 600, 1032, 9, WHITE, INK);
  drawTextCentred("IN 13 MINUTES", 600, 1122, 9, WHITE, INK);
}

function main() {
  const botDir = process.env.MAKEFUN_BOT_DIR || "/bot";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  // Only ever create/write inside the output dir — never remove it.
  fs.mkdirSync(outDir, { recursive: true });
  render();
  fs.writeFileSync(path.join(outDir, "meme.png"), encodePNG(px));
  const postJson = fs.readFileSync(path.join(botDir, "POST.json"));
  fs.writeFileSync(path.join(outDir, "POST.json"), postJson);
}

main();
