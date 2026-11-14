// Flatten the tracks into the single sequence the viewer actually sees: a list
// of back-to-back spans, each showing one clip or nothing. Preview and export
// both follow this rule, so what you scrub is what gets rendered.

import { clipAt, projectDuration } from './model.js';

export function flatten(project) {
  const total = projectDuration(project);
  const cuts = new Set([0, total]);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      cuts.add(clip.begin);
      cuts.add(clip.end);
    }
  }
  const points = [...cuts].filter((t) => t >= 0 && t <= total).sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    const hit = clipAt(project, start);
    const previous = spans.at(-1);
    if (!hit && previous && !previous.clip) {
      previous.end = end;
      continue;
    }
    spans.push({
      start,
      end,
      clip: hit ? hit.clip : null,
      track: hit ? hit.track : null,
      // Offset into the source where this span begins.
      sourceStart: hit ? hit.clip.markIn + (start - hit.clip.begin) : 0,
    });
  }
  return spans;
}
