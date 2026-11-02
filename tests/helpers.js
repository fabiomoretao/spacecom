import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processDataset } from '../src/process-dataset.js';

export const HEADER = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
export const TIMESTAMP = '2026-10-01 00:00:00';
export const NEXT_TIMESTAMP = '2026-10-01 00:00:05';

export function row(id, { faction = '', time = TIMESTAMP, lat = 0, lon = 0, victim = false, restrictions = '' } = {}) {
  return `${id};${faction};${time};${lat};${lon};${victim};${restrictions}`;
}

export function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-tests-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, input: path.join(directory, 'input.txt'), output: path.join(directory, 'output.json') };
}

export function run(t, rows, { prefix = '', newline = '\n', sortOptions } = {}) {
  const files = workspace(t);
  fs.writeFileSync(files.input, prefix + [HEADER, ...rows].join(newline));
  const stats = processDataset(files.input, files.output, undefined, undefined, sortOptions);
  return { ...files, stats, encounters: JSON.parse(fs.readFileSync(files.output, 'utf8')) };
}

// Pair direction and array order are explicitly irrelevant to the challenge.
export function canonical(encounters) {
  return encounters.map(encounter => ({
    ...encounter,
    monitoradosEncontro: [...encounter.monitoradosEncontro].sort((a, b) => a - b),
  })).sort((a, b) => a.timestamp.localeCompare(b.timestamp)
    || a.monitoradosEncontro[0] - b.monitoradosEncontro[0]
    || a.monitoradosEncontro[1] - b.monitoradosEncontro[1]);
}

export function assertEncounters(actual, expected) {
  const a = canonical(actual);
  const b = canonical(expected);
  assert.equal(a.length, b.length, 'missing encounters or false positives');
  for (let i = 0; i < a.length; i++) {
    const { distanciaMetros: actualDistance, ...actualFields } = a[i];
    const { distanciaMetros: expectedDistance, ...expectedFields } = b[i];
    assert.deepEqual(actualFields, expectedFields);
    assert.ok(Number.isFinite(actualDistance));
    assert.ok(Math.abs(actualDistance - expectedDistance) <= 1e-8,
      `distance mismatch: ${actualDistance} vs ${expectedDistance}`);
  }
}
