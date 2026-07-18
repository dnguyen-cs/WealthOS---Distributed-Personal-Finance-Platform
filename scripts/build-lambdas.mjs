// Builds all Lambda deployment zips into dist/lambda/:
//
//   node scripts/build-lambdas.mjs     (or: pnpm build:lambdas)
//
//   node.zip            esbuild bundle of src/workers/wealthsim/lambda.ts (nodejs22.x)
//   go.zip              static `bootstrap` from go-worker/cmd/lambda (provided.al2023)
//   pulse-ingest.zip    esbuild bundle of src/workers/pulse/ingest.ts
//   pulse-consumer.zip  esbuild bundle of src/workers/pulse/consumer.ts
//   pulse-janitor.zip   esbuild bundle of src/workers/pulse/janitor.ts
//
// Both target x86_64 to match the Fargate fleets bit for bit - the demo
// lane inherits the parity and chaos results measured there instead of
// re-qualifying on arm64. Zips are assembled by aws-lambda-go's
// build-lambda-zip so the bootstrap binary keeps its executable bit even
// when built on Windows (Compress-Archive would silently drop it).
// Terraform (infra/lambda.tf) hashes these artifacts to detect changes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'lambda');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Run from go-worker (that module carries the aws-lambda-go dependency);
// entries land at the zip root under their base name, mode 0755.
function zip(archive, file) {
  execFileSync(
    'go',
    ['run', 'github.com/aws/aws-lambda-go/cmd/build-lambda-zip', '-o', archive, file],
    { cwd: path.join(root, 'go-worker'), stdio: 'inherit' },
  );
}

// --- Node bundles ----------------------------------------------------------
async function bundle(entry, name) {
  await build({
    entryPoints: [path.join(root, ...entry)],
    outfile: path.join(outDir, name, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'info',
  });
  zip(path.join(outDir, `${name}.zip`), path.join(outDir, name, 'index.js'));
}

await bundle(['src', 'workers', 'wealthsim', 'lambda.ts'], 'node');
await bundle(['src', 'workers', 'pulse', 'ingest.ts'], 'pulse-ingest');
await bundle(['src', 'workers', 'pulse', 'consumer.ts'], 'pulse-consumer');
await bundle(['src', 'workers', 'pulse', 'janitor.ts'], 'pulse-janitor');

// --- Go binary -------------------------------------------------------------
execFileSync('go', ['build', '-tags', 'lambda.norpc', '-ldflags', '-s -w', '-o',
  path.join(outDir, 'go', 'bootstrap'), './cmd/lambda'], {
  cwd: path.join(root, 'go-worker'),
  stdio: 'inherit',
  env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
});
zip(path.join(outDir, 'go.zip'), path.join(outDir, 'go', 'bootstrap'));

console.log(`\nlambda artifacts ready in ${outDir}`);
