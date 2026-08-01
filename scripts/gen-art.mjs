#!/usr/bin/env node
/**
 * Generate the table background + logo candidates via Replicate.
 * The API key is read from big-bad-wolf-trailer/.env and never printed.
 * Usage: node scripts/gen-art.mjs [table|logos|all]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ENV_PATH = '/Users/nathandunn/Projects/big-bad-wolf-trailer/.env';

function loadKey() {
  const text = readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?REPLICATE_API_(?:KEY|TOKEN)\s*=\s*"?([^"\s#]+)/);
    if (m) return m[1];
  }
  throw new Error('No REPLICATE_API_KEY/TOKEN found in .env');
}

const KEY = loadKey();
const MODEL = 'black-forest-labs/flux-1.1-pro';

async function generate(name, input) {
  console.log(`→ generating ${name}…`);
  const res = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60',
    },
    body: JSON.stringify({ input }),
  });
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
  const buf = await generate('table background', {
    prompt:
      'Top-down orthographic view of an empty massive medieval fantasy tavern gaming table surface filling the entire frame edge to edge. Dark hewn oak planks with subtle iron banding and faint carved stone inlay border. In the very center, a large faint compass rose worn into the wood with elegant carved letters N, S, E, W at its four points. Wood grain worn smooth by decades of card games, subtle candlelight glow from above, warm dark amber and umber tones, muted, atmospheric, high detail texture. No objects, no cards, no people, no text other than the compass letters.',
    aspect_ratio: '1:1',
    output_format: 'jpg',
    output_quality: 88,
    safety_tolerance: 2,
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
    const buf = await generate(logo.file, {
      prompt: logo.prompt,
      aspect_ratio: '1:1',
      output_format: 'png',
      safety_tolerance: 2,
    });
    writeFileSync(join('art', logo.file), buf);
    console.log(`  saved art/${logo.file} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
}

console.log('done');
