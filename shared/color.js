// Color correction. One function grades one pixel; everything else is derived
// from it: the preview samples a 3D LUT baked from it, and export hands FFmpeg
// the same LUT as a .cube file, so preview and render cannot disagree.
//
// All sliders run -100..100 with 0 meaning "no change". Pixels are
// display-referred (gamma-encoded) RGB in 0..1.

export const COLOR_PARAMS = [
  { key: 'temperature', label: 'Temperature', group: 'White balance' },
  { key: 'tint', label: 'Tint', group: 'White balance' },
  { key: 'exposure', label: 'Exposure', group: 'Light' },
  { key: 'contrast', label: 'Contrast', group: 'Light' },
  { key: 'highlights', label: 'Highlights', group: 'Light' },
  { key: 'shadows', label: 'Shadows', group: 'Light' },
  { key: 'whites', label: 'Whites', group: 'Light' },
  { key: 'blacks', label: 'Blacks', group: 'Light' },
  { key: 'saturation', label: 'Saturation', group: 'Color' },
  { key: 'vibrance', label: 'Vibrance', group: 'Color' },
];

export const DEFAULT_COLOR = Object.freeze(
  Object.fromEntries(COLOR_PARAMS.map((p) => [p.key, 0])),
);

export const LUT_SIZE = 33;

export function isIdentityColor(color) {
  return COLOR_PARAMS.every((p) => !color || !color[p.key]);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Symmetric S-curve around mid grey; power > 1 adds contrast, < 1 removes it.
function sCurve(x, power) {
  return x < 0.5 ? 0.5 * Math.pow(2 * x, power) : 1 - 0.5 * Math.pow(2 * (1 - x), power);
}

export function gradePixel(r, g, b, color) {
  const p = (key) => (color[key] || 0) / 100;

  // White balance: opposing gains on red and blue (temperature) and on green
  // versus magenta (tint), renormalized so overall brightness stays put.
  const temperature = p('temperature');
  const tint = p('tint');
  if (temperature !== 0 || tint !== 0) {
    let gr = 1 + 0.3 * temperature + 0.1 * tint;
    let gg = 1 - 0.2 * tint;
    let gb = 1 - 0.3 * temperature + 0.1 * tint;
    const norm = luma(gr, gg, gb);
    gr /= norm;
    gg /= norm;
    gb /= norm;
    r = clamp01(r * gr);
    g = clamp01(g * gg);
    b = clamp01(b * gb);
  }

  // Exposure: up to +/-2 stops, applied in linear light.
  const exposure = p('exposure');
  if (exposure !== 0) {
    const gain = Math.pow(2, exposure * 2);
    r = clamp01(Math.pow(Math.pow(r, 2.2) * gain, 1 / 2.2));
    g = clamp01(Math.pow(Math.pow(g, 2.2) * gain, 1 / 2.2));
    b = clamp01(Math.pow(Math.pow(b, 2.2) * gain, 1 / 2.2));
  }

  const contrast = p('contrast');
  if (contrast !== 0) {
    const power = Math.pow(2, contrast);
    r = sCurve(r, power);
    g = sCurve(g, power);
    b = sCurve(b, power);
  }

  // Highlights and shadows move only the bright or dark end, weighted by luma.
  const highlights = p('highlights');
  const shadows = p('shadows');
  if (highlights !== 0 || shadows !== 0) {
    const y = luma(r, g, b);
    const amount = highlights * 0.5 * y * y + shadows * 0.5 * (1 - y) * (1 - y);
    const push = (c) => clamp01(c + amount * (amount > 0 ? 1 - c : c));
    r = push(r);
    g = push(g);
    b = push(b);
  }

  // Whites scale toward or away from clipping; blacks lift or crush the floor.
  const whites = p('whites');
  if (whites !== 0) {
    const gain = 1 + whites * 0.3;
    r = clamp01(r * gain);
    g = clamp01(g * gain);
    b = clamp01(b * gain);
  }
  const blacks = p('blacks');
  if (blacks !== 0) {
    const floor = blacks * 0.15;
    const lift = (c) => clamp01(floor > 0 ? c + floor * (1 - c) : (c + floor) / (1 + floor));
    r = lift(r);
    g = lift(g);
    b = lift(b);
  }

  // Saturation scales chroma evenly; vibrance scales muted pixels more.
  const saturation = p('saturation');
  const vibrance = p('vibrance');
  if (saturation !== 0 || vibrance !== 0) {
    const y = luma(r, g, b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const k = (1 + saturation) * (1 + vibrance * (1 - chroma));
    r = clamp01(y + (r - y) * k);
    g = clamp01(y + (g - y) * k);
    b = clamp01(y + (b - y) * k);
  }

  return [r, g, b];
}

// size^3 RGB triples with red varying fastest, then green, then blue. That is
// both the .cube file order and the layout WebGL expects for a 3D texture.
export function bakeLut(color, size = LUT_SIZE) {
  const lut = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  let i = 0;
  for (let bi = 0; bi < size; bi += 1) {
    for (let gi = 0; gi < size; gi += 1) {
      for (let ri = 0; ri < size; ri += 1) {
        const [r, g, b] = gradePixel(ri * step, gi * step, bi * step, color);
        lut[i] = r;
        lut[i + 1] = g;
        lut[i + 2] = b;
        i += 3;
      }
    }
  }
  return lut;
}

export function lutToCube(lut, size = LUT_SIZE, title = 'vid grade') {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let i = 0; i < lut.length; i += 3) {
    lines.push(`${lut[i].toFixed(6)} ${lut[i + 1].toFixed(6)} ${lut[i + 2].toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function colorKey(color) {
  return COLOR_PARAMS.map((p) => (color && color[p.key]) || 0).join(',');
}
