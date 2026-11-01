import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repetitions = 20;
const warmupPairs = 5;
const memoryPath = 'memory://parse-benchmark';
const memoryFd = -1;

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 };
}

try {
  assert.equal(process.argv.length, 4, 'Usage: npm run benchmark:parse -- <snapshot-A> <snapshot-B>');
  const variants = [];
  for (const [index, name] of ['A', 'B'].entries()) {
    const directory = path.resolve(process.argv[index + 2]);
    const readerPath = path.join(directory, 'src/io/read-groups.js');
    const { readGroups } = await import(pathToFileURL(readerPath));
    const { createStats } = await import(pathToFileURL(path.join(directory, 'src/process-dataset.js')));
    variants.push({ name, directory, readGroups, createStats,
      sourceSha256: createHash('sha256').update(fs.readFileSync(readerPath)).digest('hex') });
  }
  const storage = Buffer.allocUnsafe(8 * 1024 * 1024);
  const fd = fs.openSync(path.join(root, 'data/dataset6.txt'), 'r');
  let used = 0;
  try {
    while (used < storage.length) {
      const bytes = fs.readSync(fd, storage, used, storage.length - used, null);
      if (!bytes) break;
      used += bytes;
    }
  } finally { fs.closeSync(fd); }
  const lastNewline = storage.lastIndexOf(10, used - 1);
  assert.ok(lastNewline > 0);
  const block = storage.subarray(0, lastNewline + 1);
  const original = { openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync };
  let position = 0;
  const report = {
    createdAt: new Date().toISOString(), node: process.version,
    blockBytes: block.length, inputSha256: createHash('sha256').update(block).digest('hex'),
    repetitionsPerVersion: repetitions, warmupPairs,
    method: 'Production readGroups, in-memory readSync replacement. Reported parseMs excludes memory-copy reads and synchronous group hashing, via existing hrtime.bigint instrumentation. Includes scanning, validation and grouping; no distance detection or output I/O. AB/BA pairs after five warmup pairs. Outer elapsedMs also recorded.',
    variants: variants.map(({ name, directory, sourceSha256 }) => ({ name, directory, sourceSha256 })),
    samples: [], summaries: [],
  };
  let expected;

  function run(variant) {
    const stats = variant.createStats();
    const hash = createHash('sha256');
    const encodedMetadata = new Map();
    const started = process.hrtime.bigint();
    variant.readGroups(memoryPath, (group) => {
      hash.update(group.timestamp);
      for (const key of ['ids', 'lat', 'lon']) {
        const array = group[key];
        hash.update(Buffer.from(array.buffer, array.byteOffset, group.count * array.BYTES_PER_ELEMENT));
      }
      for (let i = 0; i < group.count; i++) {
        const meta = group.meta[i];
        let encoded = encodedMetadata.get(meta);
        if (!encoded) {
          encoded = Buffer.from(JSON.stringify([meta.faction, meta.isVictim, [...meta.restrictions].sort((a, b) => a - b)]));
          encodedMetadata.set(meta, encoded);
        }
        hash.update(encoded);
      }
    }, () => { throw new Error('Unexpected rejection in the real input block'); }, stats);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const result = { version: variant.name, parseMs: stats.timingsMs.parseAndGroup, elapsedMs,
      acceptedRecords: stats.acceptedRecords, groups: stats.groups, sha256: hash.digest('hex') };
    if (!expected) expected = result;
    assert.equal(result.sha256, expected.sha256, 'Parsed values or snapshots changed');
    assert.equal(result.acceptedRecords, expected.acceptedRecords);
    assert.equal(result.groups, expected.groups);
    return result;
  }

  try {
    fs.openSync = (file, ...args) => {
      if (file !== memoryPath) return original.openSync(file, ...args);
      position = 0;
      return memoryFd;
    };
    fs.readSync = (handle, buffer, offset, length, filePosition) => {
      if (handle !== memoryFd) return original.readSync(handle, buffer, offset, length, filePosition);
      const size = Math.min(length, block.length - position);
      block.copy(buffer, offset, position, position + size);
      position += size;
      return size;
    };
    fs.closeSync = (handle) => { if (handle !== memoryFd) original.closeSync(handle); };
    for (let pair = 0; pair < warmupPairs; pair++) {
      for (const variant of pair % 2 ? [...variants].reverse() : variants) run(variant);
    }
    for (let pair = 1; pair <= repetitions; pair++) {
      for (const variant of pair % 2 ? variants : [...variants].reverse()) {
        report.samples.push({ pair, ...run(variant) });
      }
    }
  } finally { Object.assign(fs, original); }
  for (const variant of variants) {
    const samples = report.samples.filter((sample) => sample.version === variant.name);
    report.summaries.push({ version: variant.name, parseMs: summarize(samples.map((sample) => sample.parseMs)),
      elapsedMs: summarize(samples.map((sample) => sample.elapsedMs)) });
  }
  const output = path.join(root, `outputs/benchmark-parse-${report.createdAt.replaceAll(/[:.]/g, '-')}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.table(report.summaries.map((entry) => ({ version: entry.version,
    minParseMs: entry.parseMs.min.toFixed(3), medianParseMs: entry.parseMs.median.toFixed(3) })));
  console.log(`Parsed ${expected.acceptedRecords} records from ${block.length} bytes; matching hashes; report: ${output}`);
} catch (error) {
  console.error(`Parse benchmark failed: ${error.message}`);
  process.exitCode = 1;
}
