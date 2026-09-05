#!/usr/bin/env node
/**
 * Full deploy: CDK stack → Cloudflare Worker → build web with the deployed
 * endpoints → S3 sync → CloudFront invalidation. Idempotent; run
 * `npm run deploy` any time. The Worker step needs `wrangler login`.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, cwd = root, env = {}) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
};

// 1. Infra
run('npx cdk deploy --require-approval never --outputs-file outputs.json', join(root, 'infra'));

const outputs = JSON.parse(readFileSync(join(root, 'infra', 'outputs.json'), 'utf8')).Playmat;
console.log('\nStack outputs:', outputs);

// 2. Edge Worker (Archidekt proxy). URL = <worker name>.<account subdomain>.workers.dev;
//    both halves are fixed (worker/wrangler.toml, Cloudflare account), so it's a constant.
const WORKER_URL = 'https://playmat.domainellipticlanguage.workers.dev';
run('npx wrangler deploy', join(root, 'worker'));
{
  const res = await fetch(`${WORKER_URL}/archidekt/1`, { headers: { Origin: outputs.WebUrl } });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || body.id !== 1) {
    throw new Error(`Worker check failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  console.log(`\nWorker OK: ${WORKER_URL}/archidekt/1 → deck "${body.name}"`);
}

// 3. Web build against the deployed endpoints
run('npx vite build', join(root, 'web'), {
  VITE_API_BASE: outputs.ApiBase,
  VITE_REALTIME_URL: outputs.EventsRealtime,
  VITE_EVENTS_HOST: outputs.EventsHttpHost,
  VITE_ARCHIDEKT_BASE: `${WORKER_URL}/archidekt`,
});

// 4. Upload + invalidate
run(`aws s3 sync web/dist "s3://${outputs.WebBucket}" --delete`);
run(
  `aws cloudfront create-invalidation --distribution-id ${outputs.DistributionId} --paths "/*" --no-cli-pager`
);

console.log(`\n✅ Deployed: ${outputs.WebUrl}`);
