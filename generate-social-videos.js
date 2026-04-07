/**
 * BoligEffekt – Batch Social Media Video Generator
 *
 * Les content-plan.json og generer alle videoer med:
 *   1. Nano Banana (gemini-3.1-flash-image-preview) → first frame image
 *   2. Veo 3.1 (veo-3.1-generate-preview) → video
 *
 * Bruk:
 *   node generate-social-videos.js              → generer alle
 *   node generate-social-videos.js --id 1,3,5  → generer spesifikke poster
 *   node generate-social-videos.js --dry-run    → vis plan uten å generere
 */

require('dotenv').config({ path: './env' });
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('\n❌ GEMINI_API_KEY ikke satt i env-filen.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const idArg = args.find(a => a.startsWith('--id'));
const FILTER_IDS = idArg ? idArg.split('=')[1]?.split(',').map(Number) ?? [] : null;

// Paths
const PLAN_PATH = path.join(__dirname, 'content-plan.json');
const OUTPUT_BASE = path.join(__dirname, 'output', 'social-videos');
const FRAMES_DIR = path.join(OUTPUT_BASE, 'first-frames');

function ensureDirs() {
  [OUTPUT_BASE, FRAMES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { retries = 4, delayMs = 10000, label = '' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await fn(); } catch (err) {
      const msg = err?.message ?? '';
      const is503 = err?.status === 503 || msg.includes('503') || msg.includes('high demand') || msg.includes('UNAVAILABLE');
      if (is503 && attempt < retries) {
        const wait = delayMs * attempt;
        console.log(`    ⚠️  ${label}Overbelastet, venter ${wait / 1000}s (forsøk ${attempt}/${retries})…`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// ─────────────────────────────────────
// 1. Generer first-frame bilde
// ─────────────────────────────────────
async function generateFirstFrame(post) {
  const framePath = path.join(FRAMES_DIR, `${post.id}-frame.png`);

  if (fs.existsSync(framePath)) {
    console.log(`    🖼  First frame finnes allerede: ${path.relative(__dirname, framePath)}`);
    return framePath;
  }

  process.stdout.write(`    🖼  Genererer first frame… `);
  const response = await withRetry(() => ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: post.image_first_frame_prompt,
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  }), { label: `Post ${post.id} frame ` });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      const buf = Buffer.from(part.inlineData.data, 'base64');
      fs.writeFileSync(framePath, buf);
      console.log(`✅ ${(buf.length / 1024).toFixed(0)} KB`);
      return framePath;
    }
  }
  throw new Error('Ingen bildedata i respons fra Nano Banana');
}

// ─────────────────────────────────────
// 2. Generer video med Veo 3.1
// ─────────────────────────────────────
async function generateVideo(post, framePath) {
  const videoPath = path.join(OUTPUT_BASE, post.output_filename);

  if (fs.existsSync(videoPath)) {
    const size = fs.statSync(videoPath).size;
    if (size > 10000) { // > 10 KB = faktisk video
      console.log(`    🎬  Video finnes allerede: ${path.relative(__dirname, videoPath)}`);
      return videoPath;
    }
    fs.unlinkSync(videoPath); // slett ødelagt fil
  }

  process.stdout.write(`    🎬  Sender Veo 3.1 jobb… `);
  const imageBase64 = fs.readFileSync(framePath).toString('base64');

  let operation;
  try {
    operation = await ai.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt: post.veo_prompt,
      image: { imageBytes: imageBase64, mimeType: 'image/png' },
      config: {
        aspectRatio: post.aspect_ratio ?? '9:16',
        durationSeconds: post.duration_seconds ?? 8,
      },
    });
  } catch (err) {
    const s = err?.status ?? 0;
    if (s === 403 || s === 404) throw new Error(`Veo 3.1 ikke tilgjengelig (${s})`);
    throw err;
  }

  console.log(`mottatt (${operation.name?.split('/').pop() ?? '?'})`);

  const POLL_MS = 15_000;
  const TIMEOUT_MS = 6 * 60_000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    operation = await ai.operations.getVideosOperation({ operation });
    if (operation.done) break;
    const elapsed = Math.round((Date.now() - (deadline - TIMEOUT_MS)) / 1000);
    process.stdout.write(`\r    🎬  Prosesserer… ${elapsed}s       `);
  }
  process.stdout.write('\n');

  if (!operation.done) throw new Error('Video-generering tidsavbrutt etter 6 min');

  const videos = operation.response?.generatedVideos ?? [];
  if (!videos.length) throw new Error('Jobb ferdig men ingen videodata returnert');

  const vid = videos[0];
  const videoBytes = vid.video?.videoBytes ?? vid.videoBytes;

  if (videoBytes) {
    const buf = Buffer.from(videoBytes, 'base64');
    fs.writeFileSync(videoPath, buf);
    console.log(`    ✅ Video lagret: ${path.relative(__dirname, videoPath)} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    const uri = vid.video?.uri ?? vid.uri;
    if (!uri) throw new Error('Ingen videoBytes eller URI i respons');
    process.stdout.write(`    ⬇️  Laster ned video… `);
    await downloadWithRedirects(uri.includes('?') ? `${uri}&key=${API_KEY}` : `${uri}?key=${API_KEY}`, videoPath);
    const size = fs.statSync(videoPath).size;
    console.log(`✅ ${(size / 1024 / 1024).toFixed(2)} MB → ${path.relative(__dirname, videoPath)}`);
  }

  return videoPath;
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
        res.on('end', () => reject(new Error(`Nedlasting feilet ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`)));
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// ─────────────────────────────────────
// MAIN
// ─────────────────────────────────────
async function main() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  let posts = plan.posts;

  if (FILTER_IDS?.length) {
    posts = posts.filter(p => FILTER_IDS.includes(p.id));
    if (!posts.length) { console.error('Ingen poster matchet --id filter'); process.exit(1); }
  }

  console.log('\n🏠  BoligEffekt – Batch Video Generator');
  console.log(`    Plan  : ${plan.month} | ${posts.length} poster`);
  console.log(`    API   : ${API_KEY.slice(0, 8)}…${API_KEY.slice(-4)}`);
  if (DRY_RUN) console.log('    MODUS : DRY RUN – ingen generering\n');
  else console.log('');

  if (DRY_RUN) {
    console.log('Planlagte poster:\n');
    posts.forEach(p => {
      console.log(`  [${p.id}] ${p.title}`);
      console.log(`       Platform  : ${p.platform_primary}`);
      console.log(`       Format    : ${p.format}`);
      console.log(`       Hook      : "${p.hook_text}"`);
      console.log(`       Estimert  : ${p.estimated_engagement}`);
      console.log(`       Fil       : output/social-videos/${p.output_filename}\n`);
    });
    console.log(`Estimert kostnad: ~$${(posts.length * 0.52).toFixed(2)} USD (bilde $0.004 + video ~$0.52/stk)`);
    return;
  }

  ensureDirs();

  const results = { success: [], failed: [] };

  for (const post of posts) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  [${post.id}/${posts.length}] ${post.title}`);
    console.log(`  Platform: ${post.platform_primary} | Format: ${post.format}`);
    console.log(`  Hook: "${post.hook_text}"`);
    console.log('');

    try {
      const framePath = await generateFirstFrame(post);
      const videoPath = await generateVideo(post, framePath);
      results.success.push({ post, videoPath });
    } catch (err) {
      console.error(`    ❌ Feilet: ${err.message}`);
      results.failed.push({ post, error: err.message });
    }
  }

  // Oppsummering
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║          GENERERINGS-OPPSUMMERING                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  ✅ Vellykket : ${String(results.success.length).padEnd(2)} videoer${''.padEnd(28)}║`);
  console.log(`║  ❌ Feilet   : ${String(results.failed.length).padEnd(2)} videoer${''.padEnd(28)}║`);
  console.log('╠══════════════════════════════════════════════════╣');

  if (results.success.length) {
    console.log('║  Genererte filer:                                ║');
    results.success.forEach(({ post, videoPath }) => {
      const rel = path.relative(__dirname, videoPath).slice(0, 46);
      console.log(`║    🎬 ${rel.padEnd(44)}║`);
    });
  }

  if (results.failed.length) {
    console.log('║  Feil:                                           ║');
    results.failed.forEach(({ post, error }) => {
      console.log(`║    ❌ [${post.id}] ${post.title.slice(0, 38).padEnd(38)}║`);
    });
  }

  console.log('╠══════════════════════════════════════════════════╣');
  const cost = results.success.length * 0.524;
  console.log(`║  Estimert kostnad: ~$${cost.toFixed(2)} USD${''.padEnd(26)}║`);
  console.log('║  (Nano Banana: ~$0.004 + Veo 3.1: ~$0.52/video) ║');
  console.log('╚══════════════════════════════════════════════════╝');

  if (results.success.length) {
    console.log(`\n  📁 Filer lagret i: ${OUTPUT_BASE}`);
  }
}

main().catch(err => {
  console.error('\n💥 Kritisk feil:', err.message ?? err);
  process.exit(1);
});
