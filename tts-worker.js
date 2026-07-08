// 在系统 Node.js 中运行，避免 Electron 环境兼容性问题
// 文本通过 stdin 传入，避免命令行参数转义问题
const { EdgeTTS } = require('edge-tts-universal');

let text = '';
process.stdin.on('data', chunk => { text += chunk.toString(); });
process.stdin.on('end', async () => {
  text = text.trim();
  if (!text) { writeError('empty text'); process.exit(1); return; }
  try {
    // 不限制字符数：按句/标点切分成小段，逐段合成后拼接，避免 Edge TTS 单次长度上限
    const chunks = splitText(text, 1000);
    const audioBufs = [];
    for (const c of chunks) {
      try {
        const tts = new EdgeTTS(c, 'zh-CN-XiaoyiNeural');
        const result = await tts.synthesize();
        const buf = Buffer.from(await result.audio.bytes());
        if (buf.length > 0) audioBufs.push(buf);
      } catch (e) {
        console.error('[TTS] 分段合成失败（跳过该段）:', e.message);
      }
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

// 优先在句子/标点边界断开；单段超长（无标点）则强制按 maxLen 切
function splitText(text, maxLen) {
  const raw = text.match(/[^。！？!?；;：\n]*[。！？!?；;：\n]?/g) || [text];
  const chunks = [];
  let cur = '';
  for (const p of raw) {
    if (!p) continue;
    if (cur.length + p.length > maxLen) {
      if (cur) { chunks.push(cur); cur = ''; }
      if (p.length > maxLen) {
        for (let i = 0; i < p.length; i += maxLen) chunks.push(p.substring(i, i + maxLen));
      } else {
        cur = p;
      }
    } else {
      cur += p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

function writeError(msg) {
  const errBuf = Buffer.alloc(4);
  errBuf.writeUInt32LE(0, 0);
  process.stdout.write(errBuf);
  console.error('TTS worker error:', msg);
}
