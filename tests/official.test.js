import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { processDataset } from '../src/process-dataset.js';
import { workspace, assertEncounters } from './helpers.js';

for (const index of [1, 2]) {
  test(`official dataset ${index} matches every expected encounter without false positives`, t => {
    const input = fileURLToPath(new URL(`./fixtures/dataset${index}.txt`, import.meta.url));
    const expected = JSON.parse(fs.readFileSync(new URL(`./fixtures/respostas${index}.json`, import.meta.url), 'utf8'));
    const { output } = workspace(t);
    const stats = processDataset(input, output);
    assertEncounters(JSON.parse(fs.readFileSync(output, 'utf8')), expected);
    assert.equal(stats.rejectedRecords, 0);
    assert.equal(Object.values(stats.encounters).reduce((sum, count) => sum + count, 0), expected.length);
  });
}
