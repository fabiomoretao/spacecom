import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = 'https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

await Promise.all(['dataset1.txt', 'dataset2.txt', 'respostas1.json', 'respostas2.json'].map(async name => {
  const response = await fetch(base + name, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${name}: HTTP ${response.status}`);
  const remote = hash(Buffer.from(await response.arrayBuffer()));
  const local = hash(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  assert.equal(local, remote, `${name}: local fixture differs from official file`);
  console.log(`${name}: SHA-256 ${local}`);
}));
