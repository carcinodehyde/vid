// Time is stored as integer "flicks": 1/705,600,000 of a second. One frame is a
// whole number of flicks at 24, 25, 30, 60, 23.976 and 29.97 fps, so clip edges
// never drift off the frame grid, and doubles hold ~147 days exactly.

export const TICKS = 705600000;

export const FRAME_RATES = {
  '23.976': { num: 24000, den: 1001 },
  '24': { num: 24, den: 1 },
  '25': { num: 25, den: 1 },
  '29.97': { num: 30000, den: 1001 },
  '30': { num: 30, den: 1 },
  '60': { num: 60, den: 1 },
};

export const secToTicks = (seconds) => Math.round(seconds * TICKS);
export const ticksToSec = (ticks) => ticks / TICKS;

export function frameTicks(fps) {
  return (TICKS * fps.den) / fps.num;
}

export function snapToFrame(ticks, fps) {
  const f = frameTicks(fps);
  return Math.round(ticks / f) * f;
}

export function floorToFrame(ticks, fps) {
  const f = frameTicks(fps);
  return Math.floor(ticks / f + 1e-9) * f;
}

export function fpsKey(fps) {
  for (const [key, value] of Object.entries(FRAME_RATES)) {
    if (value.num === fps.num && value.den === fps.den) return key;
  }
  return (fps.num / fps.den).toFixed(3);
}

// Non-drop-frame timecode HH:MM:SS:FF.
export function formatTimecode(ticks, fps) {
  const base = Math.round(fps.num / fps.den);
  const frames = Math.round(Math.max(0, ticks) / frameTicks(fps));
  const ff = frames % base;
  const totalSeconds = Math.floor(frames / base);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}
