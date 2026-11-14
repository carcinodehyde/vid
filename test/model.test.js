import assert from 'node:assert/strict';
import { test } from 'node:test';

import { History } from '../shared/history.js';
import {
  addClip,
  addMedia,
  clipAt,
  createProject,
  deleteClips,
  findClip,
  getTrack,
  moveClip,
  projectDuration,
  setFormat,
  splitAt,
  splitClip,
  trimClip,
  updateClips,
  validate,
} from '../shared/model.js';
import { flatten } from '../shared/segments.js';
import { FRAME_RATES, TICKS, formatTimecode, frameTicks, secToTicks, snapToFrame } from '../shared/time.js';

const S = TICKS;

function projectWith(...durations) {
  const project = createProject();
  durations.forEach((seconds, i) => {
    addMedia(project, { id: `m${i}`, name: `m${i}.mp4`, duration: seconds * S, width: 1920, height: 1080, hasAudio: true });
  });
  return project;
}

const spans = (project, trackId = 'V1') =>
  getTrack(project, trackId).clips.map((c) => [c.begin / S, c.end / S, c.markIn / S]);

test('one frame is a whole number of ticks at every supported rate', () => {
  for (const fps of Object.values(FRAME_RATES)) {
    assert.equal(Number.isInteger(frameTicks(fps)), true);
  }
  const ntsc = FRAME_RATES['29.97'];
  assert.equal(snapToFrame(secToTicks(1), ntsc) % frameTicks(ntsc), 0);
  assert.equal(formatTimecode(secToTicks(3661.5), FRAME_RATES['30']), '01:01:01:15');
});

test('clips append end to end and report the visible clip', () => {
  const project = projectWith(4, 6);
  const a = addClip(project, { mediaId: 'm0', trackId: 'V1' });
  const b = addClip(project, { mediaId: 'm1', trackId: 'V1' });
  assert.deepEqual(spans(project), [[0, 4, 0], [4, 10, 0]]);
  assert.equal(projectDuration(project), 10 * S);
  assert.equal(clipAt(project, 3.9 * S).clip.id, a);
  assert.equal(clipAt(project, 4 * S).clip.id, b);
  assert.equal(clipAt(project, 10 * S), null);
  assert.deepEqual(validate(project), []);
});

test('split keeps the source continuous across the cut', () => {
  const project = projectWith(10);
  const left = addClip(project, { mediaId: 'm0', trackId: 'V1' });
  const right = splitClip(project, left, 3 * S);
  assert.deepEqual(spans(project), [[0, 3, 0], [3, 10, 3]]);
  assert.notEqual(right, left);
  assert.equal(splitClip(project, left, 3 * S), null, 'cutting on an edge does nothing');
  assert.equal(splitAt(project, 5 * S).length, 1);
  assert.deepEqual(spans(project), [[0, 3, 0], [3, 5, 3], [5, 10, 5]]);
});

test('free mode: trims stop at the source limits and at neighbours', () => {
  const project = projectWith(10, 10);
  const a = addClip(project, { mediaId: 'm0', trackId: 'V1' });
  const b = addClip(project, { mediaId: 'm1', trackId: 'V1' });
  trimClip(project, a, 'end', 6 * S);
  assert.deepEqual(spans(project), [[0, 6, 0], [10, 20, 0]]);
  trimClip(project, a, 'end', 99 * S);
  assert.deepEqual(spans(project)[0], [0, 10, 0], 'cannot extend past the source or into the next clip');
  trimClip(project, b, 'start', 13 * S);
  assert.deepEqual(spans(project)[1], [13, 20, 3]);
  trimClip(project, b, 'start', 0);
  assert.deepEqual(spans(project)[1], [10, 20, 0], 'cannot reveal source before its start');
  assert.deepEqual(validate(project), []);
});

test('free mode: delete leaves a gap and moves land in the nearest free slot', () => {
  const project = projectWith(4, 4, 4);
  const [a, b, c] = ['m0', 'm1', 'm2'].map((mediaId) => addClip(project, { mediaId, trackId: 'V1' }));
  deleteClips(project, [b]);
  assert.deepEqual(spans(project), [[0, 4, 0], [8, 12, 0]]);
  moveClip(project, c, 'V1', 2 * S);
  assert.deepEqual(spans(project), [[0, 4, 0], [4, 8, 0]], 'an overlapping drop snaps to the neighbour edge');
  moveClip(project, a, 'V2', 1 * S);
  assert.deepEqual(spans(project, 'V2'), [[1, 5, 0]]);
  assert.deepEqual(validate(project), []);
});

test('ripple mode: delete, trim and insert keep the track packed', () => {
  const project = projectWith(4, 4, 4, 2);
  project.rippleMode = true;
  const [a, b] = ['m0', 'm1', 'm2'].map((mediaId) => addClip(project, { mediaId, trackId: 'V1' }));
  deleteClips(project, [b]);
  assert.deepEqual(spans(project), [[0, 4, 0], [4, 8, 0]]);
  trimClip(project, a, 'end', 3 * S);
  assert.deepEqual(spans(project), [[0, 3, 0], [3, 7, 0]]);
  trimClip(project, a, 'start', 1 * S);
  assert.deepEqual(spans(project), [[0, 2, 1], [2, 6, 0]]);
  addClip(project, { mediaId: 'm3', trackId: 'V1', at: 1 * S });
  assert.deepEqual(spans(project), [[0, 1, 1], [1, 3, 0], [3, 4, 2], [4, 8, 0]], 'insert splits the clip under it');
  assert.deepEqual(validate(project), []);
});

test('the upper track wins and gaps flatten to empty spans', () => {
  const project = projectWith(10, 2);
  addClip(project, { mediaId: 'm0', trackId: 'V1' });
  const over = addClip(project, { mediaId: 'm1', trackId: 'V2', at: 4 * S });
  assert.equal(clipAt(project, 5 * S).clip.id, over);
  const flat = flatten(project).map((s) => [s.start / S, s.end / S, s.clip?.mediaId ?? null, s.sourceStart / S]);
  assert.deepEqual(flat, [[0, 4, 'm0', 0], [4, 6, 'm1', 0], [6, 10, 'm0', 6]]);
  project.tracks[0].hidden = true;
  assert.equal(flatten(project).length, 3, 'cuts stay, but the hidden track no longer shows');
  assert.equal(clipAt(project, 5 * S).clip.mediaId, 'm0');
});

test('changing aspect ratio touches the canvas, never the clips', () => {
  const project = projectWith(5);
  const id = addClip(project, { mediaId: 'm0', trackId: 'V1' });
  updateClips(project, [id], { scale: 1.5, posX: 0.1, fit: 'fill', color: { exposure: 250 } });
  const before = structuredClone(findClip(project, id).clip);
  setFormat(project, { aspect: '9:16' });
  assert.deepEqual([project.width, project.height], [1080, 1920]);
  assert.deepEqual(findClip(project, id).clip, before);
  assert.equal(before.color.exposure, 100, 'slider values are clamped');
});

test('history: commits, grouped transactions, undo and redo', () => {
  const history = new History(projectWith(4, 4));
  history.commit('Add', (p) => addClip(p, { mediaId: 'm0', trackId: 'V1' }));
  const id = getTrack(history.state, 'V1').clips[0].id;

  history.begin('Drag');
  for (const x of [1, 2, 3]) history.replace((p) => moveClip(p, id, 'V1', x * S));
  history.end();
  assert.deepEqual(spans(history.state), [[3, 7, 0]]);
  assert.equal(history.undoStack.length, 2, 'a whole drag is one undo step');

  history.undo();
  assert.deepEqual(spans(history.state), [[0, 4, 0]]);
  history.undo();
  assert.deepEqual(spans(history.state), []);
  history.redo();
  history.redo();
  assert.deepEqual(spans(history.state), [[3, 7, 0]]);

  history.begin('Nothing');
  history.end();
  assert.equal(history.undoStack.length, 2, 'an empty transaction adds no step');
});
