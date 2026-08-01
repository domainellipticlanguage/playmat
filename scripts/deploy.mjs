#!/usr/bin/env node
/**
 * Full deploy: CDK stack → build web with the deployed endpoints → S3 sync →
 * CloudFront invalidation. Idempotent; run `npm run deploy` any time.
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

// 2. Web build against the deployed endpoints
run('npx vite build', join(root, 'web'), {
  VITE_API_BASE: outputs.ApiBase,
  VITE_REALTIME_URL: outputs.EventsRealtime,
  VITE_EVENTS_HOST: outputs.EventsHttpHost,
});

// 3. Upload + invalidate
run(`aws s3 sync web/dist "s3://${outputs.WebBucket}" --delete`);
run(
  `aws cloudfront create-invalidation --distribution-id ${outputs.DistributionId} --paths "/*" --no-cli-pager`
);

console.log(`\n✅ Deployed: ${outputs.WebUrl}`);
