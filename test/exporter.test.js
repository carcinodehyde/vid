import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExport } from '../server/exporter.js';
import { addClip, addMedia, createProject, setFormat, updateClips } from '../shared/model.js';
import { TICKS } from '../shared/time.js';

function projectWithClip() {
  const project = createProject();
  addMedia(project, { id: 'm1', name: 'a.mp4', path: 'a.mp4', duration: 4 * TICKS, width: 1280, height: 720, hasAudio: true });
  const clipId = addClip(project, { mediaId: 'm1', trackId: 'V1', at: 1 * TICKS });
  return { project, clipId };
}

test('an empty timeline cannot be exported', () => {
  assert.throws(() => buildExport(createProject(), () => 'x', 'out.mp4'), /empty/);
});

test('a leading gap becomes a black span and the clip is fitted to the canvas', () => {
  const { project } = projectWithClip();
  const plan = buildExport(project, (id) => `media/${id}.mp4`, 'out.mp4');
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];

  assert.equal(plan.duration, 5 * TICKS);
  assert.equal(plan.args.filter((arg) => arg === '-i').length, 1);
  assert.ok(plan.args.includes('media/m1.mp4'));
  assert.match(graph, /concat=n=2:v=1:a=1/);
  assert.match(graph, /scale=1920:1080/);
  assert.match(graph, /overlay=x=0:y=0/);
  assert.doesNotMatch(graph, /lut3d/);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.args.at(-1), 'out.mp4');
});

test('changing the aspect ratio letterboxes, and a grade adds one LUT file', () => {
  const { project, clipId } = projectWithClip();
  setFormat(project, { aspect: '9:16' });
  updateClips(project, [clipId], { color: { exposure: 40 } });
  const plan = buildExport(project, () => 'a.mp4', 'out.mp4');
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];

  assert.match(graph, /s=1080x1920/);
  assert.match(graph, /scale=1080:608/); // 1280x720 fitted to 1080 wide
  assert.match(graph, /overlay=x=0:y=656/);
  assert.match(graph, /lut3d=file=grade_0\.cube/);
  assert.equal(plan.files.length, 1);
  assert.match(plan.files[0].content, /LUT_3D_SIZE 33/);
});

test('a muted track exports silence instead of the clip audio', () => {
  const { project } = projectWithClip();
  project.tracks.find((track) => track.id === 'V1').muted = true;
  const plan = buildExport(project, () => 'a.mp4', 'out.mp4');
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(graph, /\[0:a\]/);
});
