import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { PlaymatStack } from '../lib/stack';

// JWT signing key: generated on first synth, kept in a gitignored file so
// redeploys never invalidate live room tokens. No Secrets Manager needed.
const here = dirname(fileURLToPath(import.meta.url));
const keyPath = join(here, '..', '.jwt-key');
if (!existsSync(keyPath)) {
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  console.error('[playmat] generated new JWT key at infra/.jwt-key');
}
const jwtKey = readFileSync(keyPath, 'utf8').trim();

const app = new App();
new PlaymatStack(app, 'Playmat', {
  env: { region: 'us-east-1', account: process.env.CDK_DEFAULT_ACCOUNT },
  jwtKey,
});
