/**
 * BoligEffekt – Batch Social Media Video Generator
 *
 * Per post genereres:
 *   1. Nano Banana  → first-frame bilde per scene
 *   2. Veo 3.1      → 8 sek video-klipp per scene
 *   3. ffmpeg       → sammenslåing av 3 klipp (~24 sek)
 *   4. Gemini TTS   → norsk voiceover
 *   5. ffmpeg       → mikser voiceover over ferdig video
 *
 * Bruk:
 *   node generate-social-videos.js              → alle poster
 *   node generate-social-videos.js --id=1       → én post
 *   node generate-social-videos.js --id=1,3     → velg poster
 *   node generate-social-videos.js --dry-run    → vis plan
 */

require('dotenv').config({ path: './env' });
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile, execFileSync } = require('child_process');

// ── API ──────────────────────────────────────────────────────────────────────
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('\n❌ GEMINI_API_KEY ikke satt i env-filen.'); process.exit(1); }
const ai = new GoogleGenAI({ apiKey: API_KEY });

// ── ffmpeg ────────────────────────────────────────────────────────────────────
const FFMPEG_CANDIDATES = [
  'ffmpeg',
  'C:\\Users\\andri\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe',
];
const FFMPEG = (() => {
  for (const c of FFMPEG_CANDIDATES) {
    try { execFileSync(c, ['-version'], { stdio: 'pipe' }); return c; } catch {}
  }
  return null;
})();

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const idArg = args.find(a => a.startsWith('--id'));
const FILTER_IDS = idArg ? (idArg.split('=')[1] ?? '').split(',').map(Number).filter(Boolean) : null;

// ── Paths ─────────────────────────────────────────────────────────────────────
const PLAN_PATH    = path.join(__dirname, 'content-plan.json');
const OUTPUT_BASE  = path.join(__dirname, 'output', 'social-videos');
const FRAMES_DIR   = path.join(OUTPUT_BASE, 'first-frames');
const CLIPS_DIR    = path.join(OUTPUT_BASE, 'clips');
const TMP_DIR      = path.join(OUTPUT_BASE, 'tmp');

function ensureDirs() {
  [OUTPUT_BASE, FRAMES_DIR, CLIPS_DIR, TMP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { retries = 5, delayMs = 10000, label = '' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await fn(); } catch (err) {
      const msg = err?.message ?? '';
      const is429 = err?.status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      const retryable =
        is429 ||
        err?.status === 503 ||
        msg.includes('503') ||
        msg.includes('high demand') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('fetch failed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('network');
      if (retryable && attempt < retries) {
        const wait = is429 ? 120_000 : delayMs * attempt; // 429 → vent 2 min
        console.log(`    ⚠️  ${label}${is429 ? 'Rate limit' : 'Feil'} – venter ${wait / 1000}s (forsøk ${attempt}/${retries})…`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { stdio: 'pipe' }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.slice(-400) ?? err.message));
      else resolve();
    });
  });
}

function downloadWithRedirects(url, destPath, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('For mange omdirigeringer'));
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        return downloadWithRedirects(res.headers.location, destPath, depth + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`Nedlasting feilet ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 300)}`)));
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// ── STEG 1: First-frame bilde ─────────────────────────────────────────────────
async function generateFrame(postId, sceneOrder, prompt) {
  const framePath = path.join(FRAMES_DIR, `${postId}-scene${sceneOrder}.png`);
  if (fs.existsSync(framePath)) {
    process.stdout.write(`    🖼  Scene ${sceneOrder} frame finnes\n`);
    return framePath;
  }

  process.stdout.write(`    🖼  Scene ${sceneOrder} – genererer bilde… `);
  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: prompt,
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  }), { label: `Scene ${sceneOrder} bilde ` });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      const buf = Buffer.from(part.inlineData.data, 'base64');
      fs.writeFileSync(framePath, buf);
      console.log(`✅ ${(buf.length / 1024).toFixed(0)} KB`);
      return framePath;
    }
  }
  throw new Error('Ingen bildedata fra Nano Banana');
}

// ── STEG 2: Veo 3.1 video-klipp ──────────────────────────────────────────────
async function generateClip(postId, scene, framePath) {
  const clipPath = path.join(CLIPS_DIR, `${postId}-scene${scene.order}.mp4`);

  if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 50000) {
    process.stdout.write(`    🎬  Scene ${scene.order} klipp finnes\n`);
    return clipPath;
  }

  process.stdout.write(`    🎬  Scene ${scene.order} – sender Veo-jobb… `);
  const imageBase64 = fs.readFileSync(framePath).toString('base64');

  let operation;
  try {
    operation = await withRetry(() => ai.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt: scene.veo_prompt,
      image: { imageBytes: imageBase64, mimeType: 'image/png' },
      config: { aspectRatio: '9:16', durationSeconds: 8 },
    }), { label: `Scene ${scene.order} Veo ` });
  } catch (err) {
    const s = err?.status ?? 0;
    if (s === 403 || s === 404) throw new Error(`Veo 3.1 ikke tilgjengelig (${s})`);
    throw err;
  }

  console.log(`sendt`);

  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    await sleep(15_000);
    operation = await ai.operations.getVideosOperation({ operation });
    if (operation.done) break;
    const elapsed = Math.round((Date.now() - (deadline - 6 * 60_000)) / 1000);
    process.stdout.write(`\r    🎬  Scene ${scene.order} – prosesserer… ${elapsed}s   `);
  }
  process.stdout.write('\n');

  if (!operation.done) throw new Error(`Scene ${scene.order}: tidsavbrutt`);

  const videos = operation.response?.generatedVideos ?? [];
  if (!videos.length) throw new Error(`Scene ${scene.order}: ingen video returnert`);

  const vid = videos[0];
  const videoBytes = vid.video?.videoBytes ?? vid.videoBytes;

  if (videoBytes) {
    const buf = Buffer.from(videoBytes, 'base64');
    fs.writeFileSync(clipPath, buf);
    process.stdout.write(`    ✅ Scene ${scene.order} lagret (${(buf.length / 1024 / 1024).toFixed(2)} MB)\n`);
  } else {
    const uri = vid.video?.uri ?? vid.uri;
    if (!uri) throw new Error('Ingen videoBytes eller URI');
    process.stdout.write(`    ⬇️  Scene ${scene.order} – laster ned… `);
    const dlUrl = uri.includes('?') ? `${uri}&key=${API_KEY}` : `${uri}?key=${API_KEY}`;
    await downloadWithRedirects(dlUrl, clipPath);
    const size = fs.statSync(clipPath).size;
    console.log(`✅ ${(size / 1024 / 1024).toFixed(2)} MB`);
  }

  return clipPath;
}

// ── STEG 3: Sett sammen klipp med ffmpeg ─────────────────────────────────────
async function concatenateClips(postId, clipPaths) {
  if (!FFMPEG) throw new Error('ffmpeg ikke funnet');

  const concatPath = path.join(TMP_DIR, `${postId}-raw.mp4`);
  const listFile   = path.join(TMP_DIR, `${postId}-clips.txt`);

  // Re-enkode hvert klipp til samme format for sømløs sammenslåing
  const reencoded = [];
  for (const [i, clipPath] of clipPaths.entries()) {
    const rePath = path.join(TMP_DIR, `${postId}-re${i}.mp4`);
    process.stdout.write(`    ✂️  Re-enkoder klipp ${i + 1}/${clipPaths.length}… `);
    await runFFmpeg([
      '-y', '-i', clipPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
      '-r', '30', '-an',
      rePath,
    ]);
    console.log('✅');
    reencoded.push(rePath);
  }

  // Lag concat-liste
  fs.writeFileSync(listFile, reencoded.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));

  process.stdout.write(`    🔗  Slår sammen ${clipPaths.length} klipp… `);
  await runFFmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    concatPath,
  ]);
  console.log('✅');

  // Rydd opp
  reencoded.forEach(p => { try { fs.unlinkSync(p); } catch {} });
  try { fs.unlinkSync(listFile); } catch {}

  return concatPath;
}

// ── STEG 4: Norsk voiceover med Gemini TTS ───────────────────────────────────
async function generateVoiceover(postId, script) {
  const pcmPath = path.join(TMP_DIR, `${postId}-voice.pcm`);

  process.stdout.write(`    🎙  Genererer norsk voiceover… `);
  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ parts: [{ text: script }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
      },
    },
  }), { label: `Post ${postId} TTS ` });

  const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
  if (!audioPart) throw new Error('Ingen audiodata i TTS-respons');

  const buf = Buffer.from(audioPart.inlineData.data, 'base64');
  fs.writeFileSync(pcmPath, buf);
  const durationSec = buf.length / 2 / 24000;
  console.log(`✅ ${durationSec.toFixed(1)} sek`);
  return { pcmPath, durationSec };
}

// ── STEG 5: Mikse voiceover inn i video ──────────────────────────────────────
async function mergeVoiceover(postId, videoPath, pcmPath, outputFilename) {
  if (!FFMPEG) throw new Error('ffmpeg ikke funnet');

  const finalPath = path.join(OUTPUT_BASE, outputFilename);

  process.stdout.write(`    🔊  Mikser voiceover inn i video… `);
  await runFFmpeg([
    '-y',
    // Input 0: rå PCM voiceover (signed 16-bit LE, 24 kHz, mono)
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath,
    // Input 1: video (uten lyd)
    '-i', videoPath,
    // Bruk video fra input 1, lyd fra input 0
    '-map', '1:v:0',
    '-map', '0:a:0',
    // Klipp til korteste (voiceover) — men pad video til voiceover-lengde
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    // Sørg for at video og audio starter likt
    '-async', '1',
    finalPath,
  ]);

  const size = fs.statSync(finalPath).size;
  console.log(`✅ ${(size / 1024 / 1024).toFixed(2)} MB`);
  return finalPath;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  let posts = plan.posts;

  if (FILTER_IDS?.length) {
    posts = posts.filter(p => FILTER_IDS.includes(p.id));
    if (!posts.length) { console.error('Ingen poster matchet --id filter'); process.exit(1); }
  }

  console.log('\n🏠  BoligEffekt – Batch Video Generator');
  console.log(`    Plan   : ${plan.month} | ${posts.length} poster`);
  console.log(`    ffmpeg : ${FFMPEG ? '✅' : '❌ ikke funnet'}`);
  console.log(`    API    : ${API_KEY.slice(0, 8)}…${API_KEY.slice(-4)}`);
  if (DRY_RUN) console.log('    MODUS  : DRY RUN\n');
  else console.log('');

  if (DRY_RUN) {
    posts.forEach(p => {
      console.log(`  [${p.id}] ${p.title} (${p.scenes?.length ?? 0} scener)`);
      console.log(`       Platform : ${p.platform_primary}`);
      console.log(`       Format   : ${p.format}`);
      p.scenes?.forEach(s => console.log(`       Scene ${s.order}  : ${s.description}`));
      console.log(`       Voice    : "${p.voiceover_script?.slice(0, 60)}…"`);
      console.log('');
    });
    const scenesTotal = posts.reduce((a, p) => a + (p.scenes?.length ?? 0), 0);
    console.log(`Estimert kostnad: ~$${(scenesTotal * 0.52 + posts.length * 0.004).toFixed(2)} USD`);
    return;
  }

  ensureDirs();

  const results = { success: [], failed: [] };

  for (const post of posts) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  [${post.id}] ${post.title}`);
    console.log(`  Platform: ${post.platform_primary} | ${post.scenes?.length ?? 0} scener`);
    console.log('');

    try {
      const scenes = post.scenes ?? [];
      const clipPaths = [];

      // Generer first-frame + klipp for hver scene
      for (const scene of scenes) {
        const framePath = await generateFrame(post.id, scene.order, scene.image_prompt);
        const clipPath  = await generateClip(post.id, scene, framePath);
        clipPaths.push(clipPath);
      }

      // Sett klippene sammen
      let videoPath;
      if (clipPaths.length > 1) {
        videoPath = await concatenateClips(post.id, clipPaths);
      } else {
        videoPath = clipPaths[0];
      }

      // Voiceover
      const { pcmPath } = await generateVoiceover(post.id, post.voiceover_script);

      // Mikse lyd inn
      const finalPath = await mergeVoiceover(post.id, videoPath, pcmPath, post.output_filename);

      // Rydd tmp
      try { fs.unlinkSync(pcmPath); } catch {}
      if (clipPaths.length > 1) { try { fs.unlinkSync(videoPath); } catch {} }

      results.success.push({ post, finalPath });
      console.log(`\n  ✅ Ferdig: ${path.relative(__dirname, finalPath)}`);

    } catch (err) {
      console.error(`\n  ❌ Feilet: ${err.message}`);
      results.failed.push({ post, error: err.message });
    }
  }

  // ── Oppsummering ────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         GENERERINGS-OPPSUMMERING                 ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  ✅ Vellykket : ${results.success.length} poster${''.padEnd(31)}║`);
  console.log(`║  ❌ Feilet   : ${results.failed.length} poster${''.padEnd(31)}║`);
  if (results.success.length) {
    console.log('╠══════════════════════════════════════════════════╣');
    results.success.forEach(({ finalPath }) => {
      const rel = path.relative(__dirname, finalPath).slice(0, 46);
      console.log(`║  🎬 ${rel.padEnd(44)}║`);
    });
  }
  if (results.failed.length) {
    console.log('╠══════════════════════════════════════════════════╣');
    results.failed.forEach(({ post, error }) => {
      console.log(`║  ❌ [${post.id}] ${error.slice(0, 40).padEnd(40)}║`);
    });
  }
  console.log('╚══════════════════════════════════════════════════╝');

  if (results.success.length) {
    console.log(`\n  📁 output/social-videos/`);
  }
}

main().catch(err => {
  console.error('\n💥 Kritisk feil:', err.message ?? err);
  process.exit(1);
});
