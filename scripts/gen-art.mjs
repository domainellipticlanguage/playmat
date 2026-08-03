#!/usr/bin/env node
/**
 * Generate the table background + logo candidates + playmat patterns via
 * Replicate. The API key is read from the repo's .env and never printed.
 * Usage: node scripts/gen-art.mjs [table|logos|playmats|all]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ENV_PATHS = [
  new URL('../.env', import.meta.url).pathname,
  '/Users/nathandunn/Projects/big-bad-wolf-trailer/.env', // legacy location
];

function loadKey() {
  for (const path of ENV_PATHS) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?REPLICATE_API_(?:KEY|TOKEN)\s*=\s*"?([^"\s#]+)/);
      if (m) return m[1];
    }
  }
  throw new Error('No REPLICATE_API_KEY/TOKEN found in any .env');
}

const KEY = loadKey();
/** nano-banana (Gemini 2.5 Flash Image) for the table; flux for the legacy logo option. */
const TABLE_MODEL = 'google/nano-banana';
const LOGO_MODEL = 'black-forest-labs/flux-1.1-pro';

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function generate(name, model, input) {
  console.log(`→ generating ${name} (${model})…`);
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=60',
      },
      body: JSON.stringify({ input }),
    });
    if (res.status !== 429) break;
    // Low-credit accounts are throttled to ~6 req/min, burst 1. Honor retry_after.
    const body = await res.json().catch(() => ({}));
    const wait = Math.min(Number(body.retry_after) || 15, 90) + 1;
    if (attempt >= 8) throw new Error(`${name}: still throttled after ${attempt} retries`);
    console.log(`  throttled; retrying in ${wait}s…`);
    await sleep(wait);
  }
  if (!res.ok) throw new Error(`${name}: replicate ${res.status} ${await res.text()}`);
  let prediction = await res.json();
  while (['starting', 'processing'].includes(prediction.status)) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    prediction = await poll.json();
  }
  if (prediction.status !== 'succeeded') {
    throw new Error(`${name}: ${prediction.status} ${JSON.stringify(prediction.error ?? '')}`);
  }
  const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  const img = await fetch(url);
  const buf = Buffer.from(await img.arrayBuffer());
  return buf;
}

const which = process.argv[2] ?? 'all';
mkdirSync('art', { recursive: true });
mkdirSync('web/public', { recursive: true });

if (which === 'table' || which === 'all') {
  const buf = await generate('table background', TABLE_MODEL, {
    prompt:
      'A top-down texture of a large old (but well-maintained) wooden tavern table. No perspective, just flat wood-grain',
    aspect_ratio: '1:1',
    output_format: 'jpg',
  });
  writeFileSync(join('art', 'table.jpg'), buf);
  writeFileSync(join('web', 'public', 'table.jpg'), buf);
  console.log(`  saved art/table.jpg + web/public/table.jpg (${(buf.length / 1024).toFixed(0)} KB)`);
}

if (which === 'logos' || which === 'all') {
  const logos = [
    {
      file: 'logo-a-woodcut.png',
      prompt:
        "Logo for 'PLAYMAT', a virtual tabletop for a fantasy trading card game. Medieval woodcut style emblem: a rustic wooden table viewed at a slight angle with five glowing gems in white, blue, black, red, green resting on it, the word PLAYMAT in weathered carved serif capitals beneath. Warm gold and dark brown palette on a plain very dark background. Clean vector-like edges, flat shading, suitable as an app logo. No other text.",
    },
    {
      file: 'logo-b-wordmark.png',
      prompt:
        "Minimalist wordmark logo: the word 'PLAYMAT' in an elegant medieval-inspired serif, gold foil letters with subtle emboss, the letter A stylized as a tapered playing card seen in perspective. Plain very dark charcoal background, centered, generous margins, high contrast, crisp edges, suitable as a website header logo. No other elements, no other text.",
    },
    {
      file: 'logo-c-shield.png',
      prompt:
        "Heraldic crest logo for a fantasy card game table app: a compact shield bearing two crossed playing cards and a twenty-sided die at the center, small banner ribbon below reading 'PLAYMAT' in carved capitals. Gold, deep crimson and charcoal palette, flat emblem style with clean edges on a plain very dark background, suitable as an app icon. No other text.",
    },
  ];
  for (const logo of logos) {
    const buf = await generate(logo.file, LOGO_MODEL, {
      prompt: logo.prompt,
      aspect_ratio: '1:1',
      output_format: 'png',
      safety_tolerance: 2,
    });
    writeFileSync(join('art', logo.file), buf);
    console.log(`  saved art/${logo.file} (${(buf.length / 1024).toFixed(0)} KB)`);
    await sleep(11); // stay under the low-credit rate limit
  }
}

if (which === 'playmats' || which === 'all') {
  // Keep in sync with PLAYER_PALETTE in web/src/colors.ts.
  const mats = [
    { name: 'purple', desc: 'deep violet and amethyst purple' },
    { name: 'yellow', desc: 'warm golden yellow and pale amber' },
    { name: 'orange', desc: 'burnt orange and glowing ember tones' },
    { name: 'teal', desc: 'deep teal and sea-green' },
    { name: 'pink', desc: 'rose pink and soft magenta' },
    { name: 'slate', desc: 'cool blue-grey slate and silver' },
  ];
  mkdirSync(join('web', 'public', 'playmats'), { recursive: true });
  for (const mat of mats) {
    const buf = await generate(`playmat ${mat.name}`, TABLE_MODEL, {
      prompt:
        `Abstract fantasy playmat art dominated by ${mat.desc}: flowing arcane energy ` +
        'ribbons and faint geometric linework drifting across a very dark charcoal ' +
        `background, the ${mat.desc.split(' and ')[0]} glow gathered in elegant curving streams. ` +
        'Painterly, atmospheric, understated and dark overall so playing cards placed on top ' +
        'stay readable. No text, no letters, no symbols, no creatures, no objects, no border, no frame.',
      aspect_ratio: '16:9',
      output_format: 'jpg',
    });
    writeFileSync(join('art', `playmat-${mat.name}.jpg`), buf);
    writeFileSync(join('web', 'public', 'playmats', `${mat.name}.jpg`), buf);
    console.log(`  saved web/public/playmats/${mat.name}.jpg (${(buf.length / 1024).toFixed(0)} KB)`);
    await sleep(11); // stay under the low-credit rate limit
  }
}

console.log('done');
