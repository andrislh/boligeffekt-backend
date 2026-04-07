/**
 * BoligEffekt – Gemini Nano Banana + Veo 3.1 Video Generation Test
 *
 * Tests:
 *  1. Image generation with gemini-2.0-flash-preview-image-generation (Nano Banana)
 *  2. Video generation with veo-3.1-generate-preview (Veo 3.1) using the image as first frame
 *  3. Fallback: 5 BoligEffekt social media images if Veo 3.1 is unavailable
 */

require('dotenv').config({ path: './env' });
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('\n❌ GEMINI_API_KEY not set. Add it to your env file.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// Output directories
const OUTPUT_DIR = path.join(__dirname, 'output');
const SOCIAL_DIR = path.join(OUTPUT_DIR, 'social-images');

function ensureDirs() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(SOCIAL_DIR)) fs.mkdirSync(SOCIAL_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, { retries = 4, delayMs = 8000, label = '' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is503 = err?.status === 503 || (err?.message ?? '').includes('503') || (err?.message ?? '').includes('high demand') || (err?.message ?? '').includes('UNAVAILABLE');
      if (is503 && attempt < retries) {
        const wait = delayMs * attempt;
        console.log(`  ⚠️  ${label}503 overloaded, retrying in ${wait / 1000}s (attempt ${attempt}/${retries})…`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────
// STEP 1: Generate house image with Nano Banana
// ─────────────────────────────────────────────
async function generateHouseImage() {
  const MODEL = 'gemini-3.1-flash-image-preview';
  const PROMPT = 'A photorealistic Norwegian wooden house (hytte style) in winter, snow on the roof, warm interior lights visible through windows, clean Scandinavian aesthetic, golden hour lighting';
  const OUTPUT_PATH = path.join(OUTPUT_DIR, 'test-house.png');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 1: Image Generation (Nano Banana)');
  console.log(`  Model : ${MODEL}`);
  console.log(`  Output: ${OUTPUT_PATH}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (fs.existsSync(OUTPUT_PATH)) {
    console.log(`  ✅ Image already exists, skipping generation: ${OUTPUT_PATH}`);
    return OUTPUT_PATH;
  }

  const response = await withRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: PROMPT,
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  }), { label: 'Image gen ' });

  let imageSaved = false;
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      const imgBuffer = Buffer.from(part.inlineData.data, 'base64');
      fs.writeFileSync(OUTPUT_PATH, imgBuffer);
      console.log(`  ✅ Image saved: ${OUTPUT_PATH} (${(imgBuffer.length / 1024).toFixed(1)} KB)`);
      imageSaved = true;
      break;
    }
  }

  if (!imageSaved) {
    throw new Error('No image data in response from Nano Banana');
  }

  return OUTPUT_PATH;
}

// ─────────────────────────────────────────────
// STEP 2: Generate video with Veo 3.1
// ─────────────────────────────────────────────
async function generateVideo(imageFilePath) {
  const MODEL = 'veo-3.1-generate-preview';
  const PROMPT = 'Slow cinematic pan across the Norwegian house facade, soft snowflakes falling gently, warm light glowing from windows, peaceful winter atmosphere, 9:16 portrait format for social media';
  const OUTPUT_PATH = path.join(OUTPUT_DIR, 'boligeffekt-test.mp4');
  const POLL_INTERVAL_MS = 15_000;
  const TIMEOUT_MS = 5 * 60_000;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 2: Video Generation (Veo 3.1)');
  console.log(`  Model : ${MODEL}`);
  console.log(`  Output: ${OUTPUT_PATH}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Read image as base64
  const imageData = fs.readFileSync(imageFilePath);
  const imageBase64 = imageData.toString('base64');

  // Submit generation job
  let operation;
  try {
    operation = await ai.models.generateVideos({
      model: MODEL,
      prompt: PROMPT,
      image: {
        imageBytes: imageBase64,
        mimeType: 'image/png',
      },
      config: {
        aspectRatio: '9:16',
        durationSeconds: 8,
      },
    });
  } catch (err) {
    const status = err?.status ?? err?.code;
    if (status === 403 || status === 404 || (err.message && (err.message.includes('403') || err.message.includes('404') || err.message.includes('not found') || err.message.includes('permission')))) {
      console.log(`  ⚠️  Veo 3.1 not available on this API key (${status ?? 'access denied'})`);
      return null;
    }
    throw err;
  }

  console.log(`  ⏳ Job submitted (name: ${operation.name ?? 'unknown'}). Polling every 15s…`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    operation = await ai.operations.getVideosOperation({ operation });

    if (operation.done) {
      const videos = operation.response?.generatedVideos ?? operation.response?.generatedSamples ?? operation.response?.videos ?? [];
      if (!videos.length) {
        throw new Error('Video job completed but no video data returned');
      }

      const vid = videos[0];
      // Check for inline bytes first, then URI
      const videoBytes = vid.video?.videoBytes ?? vid.videoBytes;
      if (videoBytes) {
        const videoBuffer = Buffer.from(videoBytes, 'base64');
        fs.writeFileSync(OUTPUT_PATH, videoBuffer);
        console.log(`  ✅ Video saved: ${OUTPUT_PATH} (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
      } else {
        const uri = vid.video?.uri ?? vid.uri;
        if (!uri) throw new Error('No video bytes or URI in response');
        console.log(`  ⬇️  Downloading video from URI…`);
        const https = require('https');
        const http = require('http');
        const downloadUrl = uri.includes('?') ? `${uri}&key=${API_KEY}` : `${uri}?key=${API_KEY}`;

        await new Promise((resolve, reject) => {
          function download(url, depth = 0) {
            if (depth > 5) return reject(new Error('Too many redirects'));
            const client = url.startsWith('https') ? https : http;
            client.get(url, res => {
              if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                const location = res.headers.location;
                res.resume(); // drain
                return download(location, depth + 1);
              }
              if (res.statusCode !== 200) {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => reject(new Error(`Download failed ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`)));
                return;
              }
              const file = fs.createWriteStream(OUTPUT_PATH);
              res.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
              file.on('error', reject);
            }).on('error', reject);
          }
          download(downloadUrl);
        });
        const size = fs.statSync(OUTPUT_PATH).size;
        console.log(`  ✅ Video saved: ${OUTPUT_PATH} (${(size / 1024 / 1024).toFixed(2)} MB)`);
      }
      return OUTPUT_PATH;
    }

    const elapsed = Math.round((Date.now() - (deadline - TIMEOUT_MS)) / 1000);
    console.log(`  ⏳ Still processing… (${elapsed}s elapsed)`);
  }

  throw new Error('Video generation timed out after 5 minutes');
}

// ─────────────────────────────────────────────
// STEP 3: Fallback – 5 BoligEffekt social images
// ─────────────────────────────────────────────
const FALLBACK_PROMPTS = [
  {
    filename: '01-energy-rating-label.png',
    prompt: 'Norwegian house with visible energy rating label A shown on door, photorealistic, clean modern style',
  },
  {
    filename: '02-cold-vs-warm-house.png',
    prompt: 'Split image showing cold drafty house vs warm energy efficient modern Norwegian home',
  },
  {
    filename: '03-drone-neighborhood.png',
    prompt: 'Overhead drone shot of Norwegian residential neighborhood in winter, photorealistic',
  },
  {
    filename: '04-shocked-homeowner-bill.png',
    prompt: 'Close up of energy bill invoice with shocked Norwegian homeowner, cinematic',
  },
  {
    filename: '05-energy-scale-infographic.png',
    prompt: 'Clean infographic style: energy scale A to G with Norwegian house silhouettes',
  },
];

async function generateFallbackImages() {
  const MODEL = 'gemini-3.1-flash-image-preview';
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 3: Fallback – 5 BoligEffekt Social Images');
  console.log(`  Model : ${MODEL}`);
  console.log(`  Output: ${SOCIAL_DIR}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const saved = [];
  for (let i = 0; i < FALLBACK_PROMPTS.length; i++) {
    const { filename, prompt } = FALLBACK_PROMPTS[i];
    const outputPath = path.join(SOCIAL_DIR, filename);
    process.stdout.write(`  [${i + 1}/5] Generating ${filename}… `);

    const response = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    }), { label: `Fallback img ${i + 1} ` });

    let imageSaved = false;
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imgBuffer = Buffer.from(part.inlineData.data, 'base64');
        fs.writeFileSync(outputPath, imgBuffer);
        console.log(`✅ ${(imgBuffer.length / 1024).toFixed(1)} KB`);
        saved.push(outputPath);
        imageSaved = true;
        break;
      }
    }
    if (!imageSaved) {
      console.log('⚠️  no image data returned');
    }
  }
  return saved;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.log('\n🏠  BoligEffekt – Gemini Media Generation Test');
  console.log(`    API key: ${API_KEY.slice(0, 8)}…${API_KEY.slice(-4)}`);
  console.log(`    Date   : ${new Date().toISOString()}`);

  ensureDirs();

  const results = {
    imageModel: 'gemini-3.1-flash-image-preview',
    videoModel: 'veo-3.1-generate-preview',
    houseImage: null,
    video: null,
    fallbackImages: [],
    veoAvailable: false,
  };

  // Step 1 – house image
  try {
    results.houseImage = await generateHouseImage();
  } catch (err) {
    console.error(`\n  ❌ Image generation failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Step 2 – video
  try {
    const videoPath = await generateVideo(results.houseImage);
    if (videoPath) {
      results.video = videoPath;
      results.veoAvailable = true;
    } else {
      // Veo not available – run fallback
      results.fallbackImages = await generateFallbackImages();
    }
  } catch (err) {
    console.error(`\n  ❌ Video generation failed: ${err.message}`);
    // Still try fallback
    console.log('\n  Attempting fallback image generation…');
    try {
      results.fallbackImages = await generateFallbackImages();
    } catch (fbErr) {
      console.error(`  ❌ Fallback also failed: ${fbErr.message}`);
    }
  }

  // ─── Summary ───────────────────────────────
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║          GENERATION SUMMARY                ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║ Nano Banana 3.1      : ✅ Available        ║`);
  console.log(`║ Veo 3.1 (video)      : ${results.veoAvailable ? '✅ Available        ║' : '❌ Not available    ║'}`);
  console.log('╠════════════════════════════════════════════╣');
  console.log('║ Generated assets:                          ║');
  if (results.houseImage) {
    console.log(`║   🖼  ${path.relative(__dirname, results.houseImage).padEnd(38)}║`);
  }
  if (results.video) {
    console.log(`║   🎬  ${path.relative(__dirname, results.video).padEnd(38)}║`);
  }
  for (const img of results.fallbackImages) {
    const rel = path.relative(__dirname, img);
    console.log(`║   🖼  ${rel.slice(0, 38).padEnd(38)}║`);
  }
  console.log('╠════════════════════════════════════════════╣');
  console.log('║ Estimated costs (per run):                 ║');
  console.log('║   Nano Banana image  : ~$0.004 USD         ║');
  if (results.veoAvailable) {
    console.log('║   Veo 3.1 video      : ~$0.35–0.70 USD    ║');
  } else {
    console.log('║   5 fallback images  : ~$0.02 USD total    ║');
  }
  console.log('╚════════════════════════════════════════════╝');
}

main().catch(err => {
  console.error('\n💥 Unhandled error:', err.message ?? err);
  process.exit(1);
});
