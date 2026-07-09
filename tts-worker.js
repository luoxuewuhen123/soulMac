// 在系统 Node.js 中运行，避免 Electron 环境兼容性问题
// 文本通过 stdin 传入，避免命令行参数转义问题
const { EdgeTTS } = require('edge-tts-universal');

let text = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { text += chunk; });
process.stdin.on('end', async () => {
  text = text.trim();
  if (!text) { writeError('empty text'); process.exit(1); return; }
  try {
    // 不分段，整段文本一次性合成
    const audioBufs = [];
    try {
      const tts = new EdgeTTS(text, 'zh-CN-XiaoyiNeural');
      const result = await tts.synthesize();
      const buf = Buffer.from(await result.audio.bytes());
      if (buf.length > 0) audioBufs.push(buf);
    } catch (e) {
      console.error('[TTS] 合成失败:', e.message);
    }
    if (audioBufs.length === 0) { writeError('all chunks failed'); process.exit(1); return; }
    const total = audioBufs.reduce((s, b) => s + b.length, 0);
    const out = Buffer.concat(audioBufs);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(total, 0);
    process.stdout.write(lenBuf);
    process.stdout.write(out);
  } catch (e) {
    writeError(e.message);
    process.exit(1);
  }
});

function writeError(msg) {
  const errBuf = Buffer.alloc(4);
  errBuf.writeUInt32LE(0, 0);
  process.stdout.write(errBuf);
  console.error('TTS worker error:', msg);
}
