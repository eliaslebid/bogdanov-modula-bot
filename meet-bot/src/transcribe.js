import { readFile, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3';
const MAX_BYTES = 24 * 1024 * 1024; // Groq's hard limit is 25 MB

function ffmpegToOpus(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
      '-f', 'ogg',
      outputPath,
    ]);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg transcode exited ${code}`));
    });
    proc.on('error', reject);
  });
}

// Transcribe a WAV file via Groq Whisper.
// Transcodes to 32 kbps opus first so long meetings fit under Groq's 25 MB limit
// (~110 min of content at that bitrate).
export async function transcribe(wavPath, {
  apiKey,
  model = DEFAULT_MODEL,
  language, // optional hint; omit to auto-detect
} = {}) {
  if (!apiKey) throw new Error('GROQ_API_KEY missing');

  const opusPath = wavPath.replace(/\.wav$/, '.ogg');
  await ffmpegToOpus(wavPath, opusPath);

  try {
    const { size } = await stat(opusPath);
    if (size > MAX_BYTES) {
      throw new Error(`transcoded file is ${(size / 1024 / 1024).toFixed(1)} MB, exceeds Groq's 25 MB limit — split needed`);
    }

    const buf = await readFile(opusPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'audio.ogg');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language);

    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq STT ${res.status}: ${body.slice(0, 300)}`);
    }

    // { text, language, duration, segments: [...] }
    return await res.json();
  } finally {
    await unlink(opusPath).catch(() => {});
  }
}
