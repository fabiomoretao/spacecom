import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
fs.mkdirSync(new URL('../outputs/', import.meta.url), { recursive: true });

try {
  for (const dataset of [1, 2]) {
    const output = `outputs/dataset${dataset}.json`;
    const run = spawnSync(process.execPath, ['src/cli.js', `data/dataset${dataset}.txt`, output], {
      cwd: root, encoding: 'utf8',
    });
    process.stderr.write(run.stderr ?? '');
    if (run.error) throw run.error;
    assert.equal(run.status, 0, `dataset ${dataset} must succeed`);
    assert.ok(!fs.existsSync(new URL(`../${output}.rejects.jsonl`, import.meta.url)), 'rejection log must be absent');
    const actual = JSON.parse(fs.readFileSync(new URL(`../${output}`, import.meta.url)));
    const reference = JSON.parse(fs.readFileSync(new URL(`../data/respostas${dataset}.json`, import.meta.url)));
    for (const records of [actual, reference]) {
      for (const record of records) record.monitoradosEncontro.sort((a, b) => a - b);
      records.sort((a, b) => a.timestamp.localeCompare(b.timestamp)
        || a.monitoradosEncontro[0] - b.monitoradosEncontro[0]
        || a.monitoradosEncontro[1] - b.monitoradosEncontro[1]);
    }
    assert.equal(actual.length, reference.length);
    let maxDifference = 0;
    for (let i = 0; i < reference.length; i++) {
      const { distanciaMetros: distance, ...record } = actual[i];
      const { distanciaMetros: expectedDistance, ...expected } = reference[i];
      assert.deepEqual(record, expected);
      const difference = Math.abs(distance - expectedDistance);
      assert.ok(difference <= 1e-9, `distance mismatch for dataset ${dataset}, encounter ${i}`);
      maxDifference = Math.max(maxDifference, difference);
    }
    console.log(`Dataset ${dataset}: ${actual.length} official encounters match; max absolute distance difference = ${maxDifference} m; zero rejections`);
  }
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
}
