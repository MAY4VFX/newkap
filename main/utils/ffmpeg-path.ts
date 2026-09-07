import ffmpeg from 'ffmpeg-static';
import util from 'electron-util';

// ffmpeg-static@5 types this `string | null` (null on an unsupported
// platform/arch, see its index.js) instead of always `string`. This app only
// ships for platforms ffmpeg-static bundles a binary for, so this can't
// actually be null in practice.
if (!ffmpeg) {
  throw new Error('ffmpeg-static has no binary for this platform/arch');
}

const ffmpegPath = util.fixPathForAsarUnpack(ffmpeg);

export default ffmpegPath;
