import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createStats, processDataset } from '../src/process-dataset.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const HEADER = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const TIME = '2024-01-01 00:00:00';
const FUTURE = '2025-01-01 00:00:00';
const row = (id = 1, time = TIME, faction = '', victim = 'false', restrictions = '') =>
  `${id};${faction};${time};0.0;0.0;${victim};${restrictions}`;

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.txt');
  const output = path.join(directory, 'output.json');
  const rejects = `${output}.rejects.jsonl`;
  return {
    directory, input, output, rejects,
    run(text, args = [input, output]) {
      if (text !== null) fs.writeFileSync(input, text);
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
      if (result.error) throw result.error;
      const summary = result.stderr.split('\n').find((line) => line.startsWith('Summary: '));
      assert.ok(summary, result.stderr);
      return { ...result, stats: JSON.parse(summary.slice('Summary: '.length)) };
    },
    readOutput() { return JSON.parse(fs.readFileSync(output, 'utf8')); },
    readRejects() { return fs.readFileSync(rejects, 'utf8').trimEnd().split('\n').map(JSON.parse); },
    assertNoTemporary() { assert.ok(!fs.readdirSync(directory).some((name) => name.endsWith('.tmp'))); },
  };
}

test('CLI produces deterministic canonical JSON and exposes generic victim counts', (t) => {
  const fixture = setup(t);
  const input = [HEADER, row(3), row(1, TIME, '', 'true'), row(2),
    row(1, '2024-01-01 00:00:01', '1'), row(2, '2024-01-01 00:00:01', '1')].join('\n');
  const result = fixture.run(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stats.acceptedRecords, 5);
  assert.equal(result.stats.groups, 2);
  assert.equal(result.stats.metadataChanges, 2);
  assert.equal(result.stats.genericWithVictim, 2);
  assert.deepEqual(result.stats.encounters, { protetiva: 0, faccao: 1, generico: 3 });
  const records = fixture.readOutput();
  assert.deepEqual(records.map((record) => record.monitoradosEncontro), [[1, 2], [1, 3], [2, 3], [1, 2]]);
  assert.equal(records[3].tipo, 'faccao');
  assert.deepEqual(Object.keys(records[0]), ['tipo', 'monitoradosEncontro', 'timestamp', 'posicoes', 'distanciaMetros']);
  const original = fs.readFileSync(fixture.output, 'utf8');
  assert.equal(original, JSON.stringify(records, null, 2));
  assert.equal(fixture.run(input).status, 0);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), original);
  assert.ok(!fs.existsSync(fixture.rejects));
  fixture.assertNoTemporary();
});

test('protective classification uses each accepted snapshot before the next group changes it', (t) => {
  const fixture = setup(t);
  const result = fixture.run([HEADER, row(1, TIME, '1', 'true', '2'), row(2, TIME, '1'),
    row(1, '2024-01-01 00:00:01', '2'), row(2, '2024-01-01 00:00:01', '1')].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.readOutput().map((record) => record.tipo), ['protetiva', 'generico']);
});

test('header-only input produces an empty array and deletes an old rejection log', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.rejects, 'old log');
  const result = fixture.run(HEADER);
  assert.equal(result.status, 0);
  assert.equal(result.stats.linesRead, 1);
  assert.equal(result.stats.groups, 0);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), '[]');
  assert.ok(!fs.existsSync(fixture.rejects));
});

test('isolated invalid, duplicate and out-of-order records are logged while valid pairs remain', (t) => {
  const fixture = setup(t);
  const result = fixture.run([HEADER, row(1), row(1), row(1, TIME, 'changed'), 'bad',
    row(2), row(1, '2023-01-01 00:00:00'), row(3)].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.readOutput().length, 3);
  assert.equal(result.stats.rejectedRecords, 4);
  assert.equal(result.stats.metadataChanges, 0);
  assert.deepEqual(fixture.readRejects().map((record) => [record.line, record.reason]), [
    [3, 'duplicate-identical'], [4, 'duplicate-conflicting'], [5, 'field-count'], [7, 'out-of-order-timestamp'],
  ]);
  assert.match(result.stderr, /WARNING: 4 rejected records/);
  assert.ok(result.stderr.includes(fixture.rejects));
});

test('custom rejection log path is the only CLI option', (t) => {
  const fixture = setup(t);
  const custom = path.join(fixture.directory, 'custom.jsonl');
  const result = fixture.run(`${HEADER}\nbad\n${row(1)}`, [fixture.input, fixture.output, '--rejects', custom]);
  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(custom));
  assert.ok(!fs.existsSync(fixture.rejects));
});

for (const [name, text] of [['zero-byte input', ''], ['incorrect header', `${HEADER}wrong\n${row(1)}`]]) {
  test(`${name} fails, removes temporary output and clears an old rejection log`, (t) => {
    const fixture = setup(t);
    fs.writeFileSync(fixture.output, 'previous output');
    fs.writeFileSync(fixture.rejects, 'old log');
    const result = fixture.run(text);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error:/);
    assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
    assert.ok(!fs.existsSync(fixture.rejects));
    fixture.assertNoTemporary();
  });
}

test('missing and unreadable inputs fail without replacing previous output', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.output, 'previous output');
  assert.equal(fixture.run(null).status, 1);
  const directoryInput = path.join(fixture.directory, 'directory-input');
  fs.mkdirSync(directoryInput);
  assert.equal(fixture.run(null, [directoryInput, fixture.output]).status, 1);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  fixture.assertNoTemporary();
});

test('invalid CLI arguments always fail and print a summary', (t) => {
  const fixture = setup(t);
  for (const args of [[], [fixture.input], [fixture.input, fixture.output, '--unknown'],
    [fixture.input, fixture.output, '--rejects'], [fixture.input, fixture.output, '--wrong', 'log'],
    ['--unknown', fixture.output], [fixture.input, fixture.output, '--rejects', '--wrong'],
    [fixture.input, fixture.output, '--rejects', 'log', 'extra']]) {
    const result = fixture.run(null, args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /Usage:/);
  }
  assert.ok(!fs.existsSync(fixture.output));
});

test('all resolved path collisions fail before deleting or overwriting any file', (t) => {
  const fixture = setup(t);
  const text = `${HEADER}\n${row(1)}`;
  fs.writeFileSync(fixture.input, text);
  fs.writeFileSync(fixture.output, 'previous output');
  const cases = [
    [fixture.input, path.join(fixture.directory, '.', 'input.txt')],
    [fixture.input, fixture.output, '--rejects', fixture.input],
    [fixture.input, fixture.output, '--rejects', fixture.output],
  ];
  if (process.platform === 'win32') cases.push([fixture.input, fixture.input.toUpperCase()]);
  for (const args of cases) {
    assert.equal(fixture.run(null, args).status, 1);
    assert.equal(fs.readFileSync(fixture.input, 'utf8'), text);
    assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  }
  fixture.assertNoTemporary();
});

test('999 earlier timestamps, an accepted record, and another 999 do not abort', (t) => {
  const fixture = setup(t);
  const result = fixture.run([HEADER, row(1, FUTURE), ...Array(999).fill(row(9)),
    row(2, FUTURE), ...Array(999).fill(row(9)), row(3, FUTURE)].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stats.rejectedRecords, 1998);
  assert.equal(result.stats.acceptedRecords, 3);
  assert.equal(fixture.readOutput().length, 3);
});

test('1000 earlier timestamps abort with the first sequence line and current group origin', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.output, 'previous output');
  const result = fixture.run([HEADER, row(1), row(1, FUTURE), ...Array(1000).fill(row(2))].join('\n'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sequence starts at line 4 \(2024-01-01 00:00:00\)/);
  assert.match(result.stderr, /current group 2025-01-01 00:00:00 started at line 3/);
  assert.equal(fixture.readRejects().length, 1000);
  assert.equal(fixture.readRejects().at(-1).line, 1003);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  fixture.assertNoTemporary();
});

test('malformed records do not reset a sequence of out-of-order rejections', (t) => {
  const fixture = setup(t);
  const result = fixture.run([HEADER, row(1, FUTURE), ...Array(500).fill(row(2)), 'bad',
    ...Array(500).fill(row(2))].join('\n'));
  assert.equal(result.status, 1);
  assert.equal(result.stats.rejections['out-of-order-timestamp'], 1000);
  assert.equal(result.stats.rejections['field-count'], 1);
  assert.equal(fixture.readRejects().at(-1).line, 1003);
  assert.ok(!fs.existsSync(fixture.output));
  fixture.assertNoTemporary();
});

test('malformed records do not increment a sequence and the end-of-file gap remains visible', (t) => {
  const fixture = setup(t);
  const result = fixture.run([HEADER, row(1, FUTURE), ...Array(999).fill(row(2)), 'bad'].join('\n'));
  assert.equal(result.status, 0);
  assert.equal(result.stats.rejections['out-of-order-timestamp'], 999);
  assert.equal(result.stats.acceptedRecords, 1);
  assert.deepEqual(fixture.readOutput(), []);
  assert.equal(fixture.readRejects().length, 1000);
  assert.match(result.stderr, /WARNING:/);
});

test('a rejected duplicate does not reset the out-of-order sequence', (t) => {
  const fixture = setup(t);
  const result = fixture.run([HEADER, row(1, FUTURE), ...Array(999).fill(row(2)),
    row(1, FUTURE), row(2)].join('\n'));
  assert.equal(result.status, 1);
  assert.equal(result.stats.rejections['out-of-order-timestamp'], 1000);
  assert.equal(result.stats.rejections['duplicate-identical'], 1);
});

test('unwritable output or rejection log is fatal and never replaces previous output', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.output, 'previous output');
  const absent = path.join(fixture.directory, 'absent', 'file');
  assert.equal(fixture.run(HEADER, [fixture.input, absent]).status, 1);
  assert.equal(fixture.run(`${HEADER}\nbad`, [fixture.input, fixture.output, '--rejects', absent]).status, 1);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  fixture.assertNoTemporary();
});

test('failure to remove an old rejection log is fatal', (t) => {
  const fixture = setup(t);
  fs.mkdirSync(fixture.rejects);
  const result = fixture.run(HEADER);
  assert.equal(result.status, 1);
  assert.ok(!fs.existsSync(fixture.output));
  fixture.assertNoTemporary();
});

test('a read error midway through processing preserves the old output and the rejection log', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.input, `${HEADER}\nbad\n${row(1)}\n${row(2)}\n`);
  fs.writeFileSync(fixture.output, 'previous output');
  const original = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (...args) => {
    if (++reads === 2) throw new Error('Injected input read failure');
    return original(...args);
  });
  const stats = createStats();
  assert.throws(() => processDataset(fixture.input, fixture.output, fixture.rejects, stats), /Injected input read failure/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  assert.equal(fixture.readRejects().length, 1);
  assert.equal(stats.acceptedRecords, 2);
  fixture.assertNoTemporary();
});

test('partial output writes are removed and preserve the previous published result', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.input, `${HEADER}\n${row(1)}\n${row(2)}`);
  fs.writeFileSync(fixture.output, 'previous output');
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  let outputFd;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (String(file).endsWith('.tmp')) outputFd = fd;
    return fd;
  });
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === outputFd) {
      originalWrite(file, '[partial');
      throw new Error('Injected output write failure');
    }
    return originalWrite(file, ...args);
  });
  assert.throws(() => processDataset(fixture.input, fixture.output), /Injected output write failure/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  fixture.assertNoTemporary();
});

test('rename failure removes the temporary file and leaves the old output intact', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.input, HEADER);
  fs.writeFileSync(fixture.output, 'previous output');
  t.mock.method(fs, 'renameSync', () => { throw new Error('Injected rename failure'); });
  assert.throws(() => processDataset(fixture.input, fixture.output), /Injected rename failure/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  fixture.assertNoTemporary();
});

test('incremental rejection log write failures abort without publishing output', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.input, `${HEADER}\nbad\nalso bad\n${row(1)}`);
  fs.writeFileSync(fixture.output, 'previous output');
  const original = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (typeof file === 'number' && ++writes === 2) throw new Error('Injected log write failure');
    return original(file, ...args);
  });
  assert.throws(() => processDataset(fixture.input, fixture.output), /Injected log write failure/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  assert.equal(fixture.readRejects().length, 1);
  fixture.assertNoTemporary();
});

test('failure to close the rejection log prevents output publication', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.input, `${HEADER}\nbad\n${row(1)}`);
  fs.writeFileSync(fixture.output, 'previous output');
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let logFd;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (file === fixture.rejects) logFd = fd;
    return fd;
  });
  t.mock.method(fs, 'closeSync', (fd) => {
    originalClose(fd);
    if (fd === logFd) throw new Error('Injected log close failure');
  });
  assert.throws(() => processDataset(fixture.input, fixture.output), /Injected log close failure/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  assert.equal(fixture.readRejects().length, 1);
  fixture.assertNoTemporary();
});

test('unexpected domain errors are fatal and do not publish the accumulated result', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.input, `${HEADER}\n${row(1)}\n${row(2)}`);
  fs.writeFileSync(fixture.output, 'previous output');
  t.mock.method(Math, 'asin', () => { throw new Error('Injected internal failure'); });
  assert.throws(() => processDataset(fixture.input, fixture.output), /Injected internal failure/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'previous output');
  fixture.assertNoTemporary();
});
