// Canvas presets and clip placement. Clip geometry is stored normalized (fit
// mode, scale factor, offset as a fraction of the canvas), so changing the
// project aspect ratio never has to rewrite a clip.

export const ASPECTS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '4:3': [1440, 1080],
  '21:9': [2560, 1080],
};

export const FIT_MODES = ['fit', 'fill', 'stretch'];

// Where a source of srcW x srcH lands on the canvas, in canvas pixels.
//   fit     - whole source visible, bars where the shapes differ
//   fill    - canvas covered, overflow cropped
//   stretch - source distorted to the canvas shape
export function destRect(srcW, srcH, canvasW, canvasH, placement = {}) {
  const { fit = 'fit', scale = 1, posX = 0, posY = 0 } = placement;
  const sourceAspect = srcW / srcH;
  const canvasAspect = canvasW / canvasH;
  let w;
  let h;
  if (fit === 'stretch') {
    w = canvasW;
    h = canvasH;
  } else if ((fit === 'fit') === (sourceAspect > canvasAspect)) {
    w = canvasW;
    h = canvasW / sourceAspect;
  } else {
    h = canvasH;
    w = canvasH * sourceAspect;
  }
  w *= scale;
  h *= scale;
  const cx = canvasW * (0.5 + posX);
  const cy = canvasH * (0.5 + posY);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
