// WebGL2 preview: draws the current video frame as a quad placed by destRect()
// and graded through a 3D LUT texture baked from the clip's color settings.

import { LUT_SIZE, bakeLut, colorKey, isIdentityColor } from '/shared/color.js';
import { destRect } from '/shared/geometry.js';

const VERTEX = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(uRect.xy + aPos * uRect.zw, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uFrame;
uniform sampler3D uLut;
uniform float uLutSize;
uniform bool uGrade;
out vec4 outColor;
void main() {
  vec3 c = texture(uFrame, vUv).rgb;
  if (uGrade) {
    // Sample at texel centres so the LUT's first and last entries map to 0 and 1.
    c = texture(uLut, c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
  }
  outColor = vec4(c, 1.0);
}`;

const MAX_PREVIEW = 1280;
const MAX_LUTS = 24;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This browser does not support WebGL2, which the preview needs.');
    this.gl = gl;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    this.uniforms = Object.fromEntries(
      ['uRect', 'uFrame', 'uLut', 'uLutSize', 'uGrade'].map((name) => [name, gl.getUniformLocation(program, name)]),
    );

    // Unit quad; aPos doubles as the texture coordinate (0,0 = top-left).
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.frameTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    for (const [name, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ]) {
      gl.texParameteri(gl.TEXTURE_2D, name, value);
    }
    gl.uniform1i(this.uniforms.uFrame, 0);
    gl.uniform1i(this.uniforms.uLut, 1);
    gl.uniform1f(this.uniforms.uLutSize, LUT_SIZE);

    this.luts = new Map();
    gl.clearColor(0, 0, 0, 1);
  }

  // Backing size follows the project shape, capped so preview stays cheap.
  resize(project) {
    const scale = Math.min(1, MAX_PREVIEW / Math.max(project.width, project.height));
    const width = Math.round(project.width * scale);
    const height = Math.round(project.height * scale);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  lutTexture(color) {
    const gl = this.gl;
    const key = colorKey(color);
    let texture = this.luts.get(key);
    if (texture) return texture;
    if (this.luts.size >= MAX_LUTS) {
      const [oldestKey, oldest] = this.luts.entries().next().value;
      gl.deleteTexture(oldest);
      this.luts.delete(oldestKey);
    }
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    for (const [name, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
    ]) {
      gl.texParameteri(gl.TEXTURE_3D, name, value);
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGB, gl.FLOAT, bakeLut(color));
    this.luts.set(key, texture);
    return texture;
  }

  clear() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Draw one frame of `video` for `clip`. Placement uses the source's real
  // dimensions, so a lower-resolution proxy lands in exactly the same place.
  draw(video, media, clip, project) {
    const gl = this.gl;
    this.clear();
    const rect = destRect(media.width, media.height, project.width, project.height, clip);
    gl.uniform4f(
      this.uniforms.uRect,
      (rect.x / project.width) * 2 - 1,
      1 - (rect.y / project.height) * 2,
      (rect.w / project.width) * 2,
      -(rect.h / project.height) * 2,
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    const grade = !isIdentityColor(clip.color);
    gl.uniform1i(this.uniforms.uGrade, grade ? 1 : 0);
    if (grade) {
      const texture = this.lutTexture(clip.color);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, texture);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // RGB (0-255) of the pixel at a fractional canvas position; used by tests.
  readPixel(fx, fy) {
    const gl = this.gl;
    const out = new Uint8Array(4);
    const x = Math.min(this.canvas.width - 1, Math.floor(fx * this.canvas.width));
    const y = Math.min(this.canvas.height - 1, Math.floor((1 - fy) * this.canvas.height));
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0], out[1], out[2]];
  }
}
