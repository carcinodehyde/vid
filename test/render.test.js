import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_COLOR, LUT_SIZE, bakeLut, gradePixel, isIdentityColor, lutToCube } from '../shared/color.js';
import { destRect } from '../shared/geometry.js';

const round = (rect) => Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, Math.round(v)]));

test('fit letterboxes, fill crops, stretch distorts', () => {
  // A 16:9 source on a 9:16 canvas.
  assert.deepEqual(round(destRect(1920, 1080, 1080, 1920, { fit: 'fit' })), { x: 0, y: 656, w: 1080, h: 608 });
  assert.deepEqual(round(destRect(1920, 1080, 1080, 1920, { fit: 'fill' })), { x: -1167, y: 0, w: 3413, h: 1920 });
  assert.deepEqual(round(destRect(1920, 1080, 1080, 1920, { fit: 'stretch' })), { x: 0, y: 0, w: 1080, h: 1920 });
  // Same shape: every mode fills the canvas exactly.
  for (const fit of ['fit', 'fill', 'stretch']) {
    assert.deepEqual(round(destRect(1280, 720, 1920, 1080, { fit })), { x: 0, y: 0, w: 1920, h: 1080 });
  }
});

test('scale and offset are relative to the canvas', () => {
  const rect = round(destRect(1920, 1080, 1920, 1080, { fit: 'fit', scale: 0.5, posX: 0.25, posY: -0.25 }));
  assert.deepEqual(rect, { x: 960, y: 0, w: 960, h: 540 });
});

test('neutral sliders leave every pixel alone', () => {
  assert.equal(isIdentityColor(DEFAULT_COLOR), true);
  for (const rgb of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.8], [0.9, 0.1, 0.4]]) {
    assert.deepEqual(gradePixel(...rgb, DEFAULT_COLOR), rgb);
  }
});

test('each slider pushes pixels the way its name says', () => {
  const grey = [0.4, 0.4, 0.4];
  const skin = [0.8, 0.55, 0.45];
  const grade = (rgb, patch) => gradePixel(...rgb, { ...DEFAULT_COLOR, ...patch });
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const chroma = (rgb) => Math.max(...rgb) - Math.min(...rgb);

  assert.ok(luma(grade(grey, { exposure: 50 })) > luma(grey));
  assert.ok(luma(grade(grey, { exposure: -50 })) < luma(grey));

  const warm = grade(grey, { temperature: 60 });
  assert.ok(warm[0] > warm[2], 'warmer means more red than blue');
  assert.ok(Math.abs(luma(warm) - luma(grey)) < 0.01, 'white balance keeps brightness');
  const green = grade(grey, { tint: -60 });
  assert.ok(green[1] > green[0]);

  assert.ok(grade([0.3, 0.3, 0.3], { contrast: 50 })[0] < 0.3);
  assert.ok(grade([0.7, 0.7, 0.7], { contrast: 50 })[0] > 0.7);
  assert.equal(grade([0.5, 0.5, 0.5], { contrast: 50 })[0], 0.5);

  const dark = [0.1, 0.1, 0.1];
  const bright = [0.9, 0.9, 0.9];
  assert.ok(grade(dark, { shadows: 80 })[0] - dark[0] > grade(bright, { shadows: 80 })[0] - bright[0]);
  assert.ok(bright[0] - grade(bright, { highlights: -80 })[0] > dark[0] - grade(dark, { highlights: -80 })[0]);
  assert.ok(grade([0, 0, 0], { blacks: 50 })[0] > 0);
  assert.ok(grade(bright, { whites: -50 })[0] < bright[0]);

  assert.ok(chroma(grade(skin, { saturation: 50 })) > chroma(skin));
  assert.deepEqual(grade(skin, { saturation: -100 }).map((c) => c.toFixed(4)), Array(3).fill(luma(skin).toFixed(4)));
  assert.ok(chroma(grade(skin, { vibrance: 50 })) > chroma(skin));

  for (const patch of [{ exposure: 100, whites: 100 }, { exposure: -100, blacks: -100 }, { saturation: 100, contrast: 100 }]) {
    for (const c of grade(skin, patch)) assert.ok(c >= 0 && c <= 1, 'output stays in range');
  }
});

test('the baked LUT is the grade function sampled on a grid', () => {
  const color = { ...DEFAULT_COLOR, exposure: 20, saturation: 30, temperature: -15 };
  const lut = bakeLut(color);
  assert.equal(lut.length, LUT_SIZE ** 3 * 3);
  // Red varies fastest: entry (r=5, g=9, b=20).
  const index = (5 + 9 * LUT_SIZE + 20 * LUT_SIZE * LUT_SIZE) * 3;
  const step = 1 / (LUT_SIZE - 1);
  const expected = gradePixel(5 * step, 9 * step, 20 * step, color);
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(lut[index + i] - expected[i]) < 1e-6);

  const identity = bakeLut(DEFAULT_COLOR, 2);
  assert.deepEqual([...identity], [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]);
  const cube = lutToCube(identity, 2).trim().split('\n');
  assert.equal(cube[1], 'LUT_3D_SIZE 2');
  assert.equal(cube.length, 4 + 8);
  assert.equal(cube[5], '1.000000 0.000000 0.000000');
});
