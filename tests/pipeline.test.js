import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processDataset } from '../src/process-dataset.js';
import { HEADER, row, run, workspace, NEXT_TIMESTAMP } from './helpers.js';

test('BOM, CRLF, quoted fields and final line without newline are accepted', t => {
  const { encounters } = run(t, [row(1, { time: '"2026-10-01 00:00:00"',
    lat: '-10.07996', lon: '-37.08384', victim: true, restrictions: '"2,3"' }),
  row(2, { lat: '-10.07987', lon: '-37.08389' })], { prefix: '\ufeff', newline: '\r\n' });
  assert.equal(encounters.length, 1);
  assert.equal(encounters[0].tipo, 'protetiva');
});

test('header-only input and an isolated individual produce an empty JSON array', t => {
  assert.deepEqual(run(t, []).encounters, []);
  assert.deepEqual(run(t, [row(1)]).encounters, []);
});

test('unordered input with duplicates survives multiple external merge rounds', t => {
  const rows = [row(1), row(2), row(1, { time: NEXT_TIMESTAMP }), row(2, { time: NEXT_TIMESTAMP })];
  const expected = run(t, rows).encounters;
  const { encounters, stats } = run(t, [...rows].reverse().concat(rows), { sortOptions: { blockSize: 1, fanIn: 2 } });
  assert.deepEqual(encounters, expected);
  assert.equal(stats.externalSort, true);
  assert.equal(stats.acceptedRecords, 4);
  assert.equal(stats.rejections['duplicate-identical'], 4);
});

test('invalid or conflicting input preserves the previous output and reports rejection', async t => {
  for (const [name, badRow, reason] of [
    ['field count', 'broken', 'field-count'],
    ['latitude', row(3, { lat: '91' }), 'invalid-latitude'],
    ['longitude', row(3, { lon: '-181' }), 'invalid-longitude'],
    ['calendar', row(3, { time: '2026-02-29 00:00:00' }), 'invalid-timestamp'],
    ['boolean', row(3, { victim: 'yes' }), 'invalid-boolean'],
    ['restriction', row(3, { victim: true, restrictions: 'x' }), 'invalid-restriction-list'],
    ['conflicting duplicate', row(1, { lat: '1' }), 'duplicate-conflicting'],
  ]) {
    await t.test(name, t => {
      const { directory, input, output } = workspace(t);
      fs.writeFileSync(input, [HEADER, row(1), row(2), badRow].join('\n'));
      fs.writeFileSync(output, 'previous output');
      assert.throws(() => processDataset(input, output), /not published/);
      assert.equal(fs.readFileSync(output, 'utf8'), 'previous output');
      const rejects = fs.readFileSync(`${output}.rejects.jsonl`, 'utf8');
      assert.match(rejects, new RegExp(reason));
      assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
    });
  }
});

test('empty input and invalid header fail without creating an output', t => {
  for (const contents of ['', 'incorrect header\n']) {
    const { input, output } = workspace(t);
    fs.writeFileSync(input, contents);
    assert.throws(() => processDataset(input, output), /header/);
    assert.equal(fs.existsSync(output), false);
  }
});

test('input cannot be overwritten through output or reject log paths', t => {
  const { input, output } = workspace(t);
  fs.writeFileSync(input, HEADER);
  assert.throws(() => processDataset(input, input), /distinct/);
  assert.throws(() => processDataset(input, output, input), /distinct/);
  assert.equal(fs.readFileSync(input, 'utf8'), HEADER);
});

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('CLI publishes JSON to nested paths and reports success via exit code', t => {
  const { directory, input } = workspace(t);
  const output = path.join(directory, 'nested', 'output.json');
  const rejects = path.join(directory, 'logs', 'rejects.jsonl');
  fs.writeFileSync(input, [HEADER, row(1), row(2), row(2)].join('\n'));
  const result = spawnSync(process.execPath, [cli, input, output, '--rejects', rejects], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).length, 1);
  assert.match(fs.readFileSync(rejects, 'utf8'), /duplicate-identical/);
  assert.match(result.stderr, /Summary:/);
});

test('CLI reports invalid arguments and failed processing with exit code 1', t => {
  assert.equal(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 1);
  const { input, output } = workspace(t);
  fs.writeFileSync(input, HEADER + '\nbroken');
  fs.writeFileSync(output, 'previous output');
  const result = spawnSync(process.execPath, [cli, input, output], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error:/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'previous output');
});
