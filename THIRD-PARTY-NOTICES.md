# Third-party notices

vid's own source code is released under the MIT License (see `LICENSE`).

The source repository contains no third-party code. The desktop app built with
`npm run dist` does: it bundles the programs below, each under its own licence.
Those licences apply to those programs only, not to vid's source code.

## FFmpeg (ffmpeg and ffprobe)

The app ships the `ffmpeg` and `ffprobe` command-line programs and runs them as
separate processes for probing, thumbnails, waveforms, preview copies and the
final render. vid does not link against or include FFmpeg code.

FFmpeg is copyright (c) the FFmpeg developers, <https://ffmpeg.org>. The builds
shipped here are configured with `--enable-gpl --enable-version3` and are
licensed under the **GNU General Public License, version 3**. The full licence
text is in `licenses/ffmpeg/` inside the installed app, and at
<https://www.gnu.org/licenses/gpl-3.0.txt>.

You may redistribute and modify these programs under the terms of that licence.
They come with no warranty.

| Program | Where the binary comes from | Build shipped in the Windows x64 app | Source |
| --- | --- | --- | --- |
| ffmpeg | npm package [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) (GPL-3.0-or-later) | 6.1.1 "essentials" build by <https://www.gyan.dev/ffmpeg/builds/> | <https://github.com/FFmpeg/FFmpeg/commit/e38092ef93> |
| ffprobe | npm package [`@ffprobe-installer/ffprobe`](https://github.com/SavageCore/node-ffprobe-installer) (LGPL-2.1; its binary packages GPL-3.0) | 2023-02-13 "essentials" build by <https://www.gyan.dev/ffmpeg/builds/> | <https://github.com/FFmpeg/FFmpeg/commit/2296078397> |

On macOS and Linux the same packages supply different builds of the same
programs, also under the GPL v3. Run the bundled `ffmpeg -version` and
`ffprobe -version` to see the exact version and configuration of the copy you
have; the matching FFmpeg source is available from <https://ffmpeg.org/download.html>
and <https://github.com/FFmpeg/FFmpeg>.

These builds statically include further libraries (for example x264, x265,
libvpx, LAME and Opus), each under its own GPL-compatible licence. The build
configuration printed by `ffmpeg -version` lists them, and
`licenses/ffmpeg/` contains the build's README.

To use different ffmpeg / ffprobe binaries, set the `VID_FFMPEG` and
`VID_FFPROBE` environment variables to their paths.

## Electron

The desktop app is built on [Electron](https://www.electronjs.org), copyright
(c) Electron contributors and GitHub Inc., under the MIT License, and includes
Chromium and Node.js with their own components and licences. The full texts are
in `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the app's
executable.

## Build tools (not shipped in the app)

[`electron-builder`](https://www.electron.build) (MIT) creates the installer.
The Windows installer itself is made with NSIS (zlib/libpng licence).
