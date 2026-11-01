import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readGroups } from '../src/io/read-groups.js';
import { createRejectLog } from '../src/io/reject-log.js';
import { createStats } from '../src/process-dataset.js';

const HEADER = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const TIME = '2024-01-01 00:00:00';
const row = (id = 1, time = TIME, faction = '', victim = 'false', restrictions = '', lat = '-1.0', lon = '-2.0') =>
  `${id};${faction};${time};${lat};${lon};${victim};${restrictions}`;

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-reader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.txt');
  const logPath = path.join(directory, 'rejects.jsonl');
  const stats = createStats();
  const groups = [];
  return {
    input, logPath, stats, groups,
    read(text, onGroup = (group) => groups.push(structuredClone(group))) {
      fs.writeFileSync(input, text);
      const log = createRejectLog(logPath, stats);
      try { readGroups(input, onGroup, log.reject, stats); }
      finally { log.close(); }
    },
    rejections() { return fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').map(JSON.parse); },
  };
}

test('short reads split every field, BOM and CRLF without losing the final line', (t) => {
  const fixture = setup(t);
  const original = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) =>
    original(fd, buffer, offset, Math.min(length, 1), position));
  fixture.read(`\uFEFF${HEADER}\r\n${row('0002147483648', `"${TIME}"`, '01', 'true', '"0002,2,9007199254740991"', '-0.1', '180.00000')}\r\n${row('9007199254740991', TIME, '', 'false', '1', '90.0', '-180.0')}`);
  assert.equal(fixture.stats.acceptedRecords, 2);
  assert.equal(fixture.stats.linesRead, 3);
  assert.equal(fixture.stats.groups, 1);
  const group = fixture.groups[0];
  assert.deepEqual([...group.ids.slice(0, group.count)], [2147483648, Number.MAX_SAFE_INTEGER]);
  assert.deepEqual([...group.lat.slice(0, group.count)], [-10000, 9000000]);
  assert.equal(group.meta[0].faction, '01');
  assert.deepEqual(group.meta[0].restrictions, new Set([2, Number.MAX_SAFE_INTEGER]));
  assert.equal(group.meta[1].restrictions.size, 0);
  assert.ok(!fs.existsSync(fixture.logPath));
});

test('a line larger than the buffer grows it and survives later buffer overwrites', (t) => {
  const fixture = setup(t);
  const faction = 'x'.repeat(4 * 1024 * 1024 + 31);
  fixture.read(`${HEADER}\n${row(1, TIME, faction)}\n${row(2, TIME, faction)}\n${row(1, '2024-01-01 00:00:01', faction)}`);
  assert.equal(fixture.stats.acceptedRecords, 3);
  assert.equal(fixture.stats.metadataChanges, 0);
  assert.equal(fixture.groups[0].meta[0].faction, faction);
  assert.equal(fixture.groups[1].meta[0].faction, faction);
});

test('group arrays double capacity and accept changing subsets of IDs', (t) => {
  const fixture = setup(t);
  const rows = Array.from({ length: 300 }, (_, i) => row(i));
  rows.push(row(299, '2024-01-01 00:00:01'));
  fixture.read([HEADER, ...rows].join('\n'));
  assert.deepEqual(fixture.groups.map((group) => group.count), [300, 1]);
  assert.ok(fixture.groups[0].ids instanceof Float64Array);
  assert.ok(fixture.groups[0].lat instanceof Int32Array);
  assert.equal(fixture.groups[1].ids[0], 299);
});

const invalidCases = [
  ['field-count', 'bad;row'],
  ['invalid-id', row('')], ['invalid-id', row('9007199254740992')],
  ['invalid-id', row('10000000000000000')], ['invalid-id', row('-1')],
  ['invalid-id', row(' 1')], ['invalid-id', row('1e2')], ['invalid-id', row('١')],
  ['invalid-timestamp', row(1, '2024-02-30 00:00:00')],
  ['invalid-timestamp', row(1, '1900-02-29 00:00:00')],
  ['invalid-timestamp', row(1, '2024-01-01 24:00:00')],
  ['invalid-timestamp', row(1, '2024-01-01 00:60:00')],
  ['invalid-timestamp', row(1, '2024-01-01 00:00:60')],
  ['invalid-timestamp', row(1, '2024-00-01 00:00:00')],
  ['invalid-timestamp', row(1, '2024-01-00 00:00:00')],
  ['invalid-timestamp', row(1, '2024-1-01 00:00:00')],
  ['invalid-timestamp', row(1, `"${TIME}`)],
  ['invalid-latitude', row(1, TIME, '', 'false', '', '90.00001')],
  ['invalid-latitude', row(1, TIME, '', 'false', '', '-90.00001')],
  ['invalid-latitude', row(1, TIME, '', 'false', '', '1')],
  ['invalid-latitude', row(1, TIME, '', 'false', '', '.1')],
  ['invalid-latitude', row(1, TIME, '', 'false', '', '+1.0')],
  ['invalid-latitude', row(1, TIME, '', 'false', '', '1.000001')],
  ['invalid-latitude', row(1, TIME, '', 'false', '', '1.0 ')],
  ['invalid-longitude', row(1, TIME, '', 'false', '', '0.0', '180.00001')],
  ['invalid-longitude', row(1, TIME, '', 'false', '', '0.0', '-180.00001')],
  ['invalid-longitude', row(1, TIME, '', 'false', '', '0.0', 'NaN')],
  ['invalid-boolean', row(1, TIME, '', 'True')],
  ['invalid-boolean', row(1, TIME, '', 'false ')],
  ['invalid-restriction-list', row(1, TIME, '', 'true', '1,,2')],
  ['invalid-restriction-list', row(1, TIME, '', 'true', ',1')],
  ['invalid-restriction-list', row(1, TIME, '', 'true', '1,')],
  ['invalid-restriction-list', row(1, TIME, '', 'true', '9007199254740992')],
  ['invalid-restriction-list', row(1, TIME, '', 'true', '"')],
  ['invalid-restriction-list', row(1, TIME, '', 'false', 'invalid')],
];

for (const [index, [reason, invalid]] of invalidCases.entries()) {
  test(`rejects ${reason} case ${index} and accepts the following line`, (t) => {
    const fixture = setup(t);
    fixture.read(`${HEADER}\n${invalid}\n${row(2)}`);
    assert.equal(fixture.stats.acceptedRecords, 1);
    assert.equal(fixture.groups[0].ids[0], 2);
    assert.deepEqual(fixture.rejections(), [{ line: 2, reason, raw: invalid.slice(0, 200) }]);
  });
}

test('first invalid column takes precedence over later defects and timestamp order', (t) => {
  const fixture = setup(t);
  fixture.read([HEADER, row(1), 'bad;x;bad;bad;bad;bad;bad',
    row(2, '2023-01-01 00:00:00', '', 'bad', '', 'bad'), row(3)].join('\n'));
  assert.deepEqual(fixture.rejections().map((record) => record.reason), ['invalid-id', 'invalid-latitude']);
  assert.equal(fixture.stats.acceptedRecords, 2);
});

test('Gregorian leap years are validated without Date and leading zero IDs are normalized', (t) => {
  const fixture = setup(t);
  fixture.read([HEADER, row('0'.repeat(50), '0000-02-29 00:00:00'),
    row(2, '2000-02-29 23:59:59'), row(3, '2024-02-29 00:00:00')].join('\n'));
  assert.equal(fixture.stats.acceptedRecords, 3);
  assert.equal(fixture.groups[0].ids[0], 0);
});

test('duplicates preserve the first position and snapshot and never update the cache', (t) => {
  const fixture = setup(t);
  fixture.read([HEADER, row(1, TIME, '1', 'true', '2,3'),
    row('01', `"${TIME}"`, '1', 'true', '"3,2,2"'),
    row(1, TIME, '2', 'false', '', '10.0'),
    row(2, TIME, '1'), row(1, '2024-01-01 00:00:01', '1', 'true', '2,3')].join('\n'));
  assert.deepEqual(fixture.rejections().map((record) => [record.line, record.reason]),
    [[3, 'duplicate-identical'], [4, 'duplicate-conflicting']]);
  assert.equal(fixture.groups[0].lat[0], -100000);
  assert.equal(fixture.groups[0].meta[0].faction, '1');
  assert.equal(fixture.stats.metadataChanges, 0);
});

test('snapshots and raw-byte cache survive buffer reuse and rejected changes', (t) => {
  const fixture = setup(t);
  const original = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) =>
    original(fd, buffer, offset, Math.min(length, 53), position));
  const snapshots = [];
  fixture.read([HEADER, row(1, TIME, '1'), row(2, TIME, '1'),
    row(1, '2024-01-01 00:00:01', '2'), row(2, '2024-01-01 00:00:01', '2'),
    row(1, '2024-01-01 00:00:02', '3', 'bad'),
    row(1, '2024-01-01 00:00:02', '2')].join('\n'), (group) => {
    snapshots.push(group.meta[0]);
    if (snapshots.length === 1) assert.equal(fixture.stats.metadataChanges, 0);
    if (snapshots.length === 2) assert.equal(fixture.stats.metadataChanges, 2);
  });
  assert.equal(snapshots[0].faction, '1');
  assert.equal(snapshots[1].faction, '2');
  assert.notEqual(snapshots[0], snapshots[1]);
  assert.equal(snapshots[1], snapshots[2]);
  assert.equal(fixture.stats.metadataChanges, 2);
});

test('metadata changes within a timestamp affect only each accepted participant', (t) => {
  const fixture = setup(t);
  fixture.read([HEADER, row(1, TIME, '1'), row(2, TIME, '1'),
    row(1, '2024-01-01 00:00:01', '2'), row(2, '2024-01-01 00:00:01', '1')].join('\n'));
  assert.deepEqual(fixture.groups[0].meta.slice(0, 2).map((meta) => meta.faction), ['1', '1']);
  assert.deepEqual(fixture.groups[1].meta.slice(0, 2).map((meta) => meta.faction), ['2', '1']);
  assert.equal(fixture.stats.metadataChanges, 1);
});

test('equivalent quoted restrictions reuse snapshots and inactive lists do not change meaning', (t) => {
  const fixture = setup(t);
  const snapshots = [];
  fixture.read([HEADER, row(1, TIME, '', 'true', '2'),
    row(1, '2024-01-01 00:00:01', '', 'true', '"02,2"'),
    row(1, '2024-01-01 00:00:02', '', 'false', '4'),
    row(1, '2024-01-01 00:00:03', '', 'false', '"5"')].join('\n'),
  (group) => snapshots.push(group.meta[0]));
  assert.equal(snapshots[0], snapshots[1]);
  assert.equal(snapshots[2], snapshots[3]);
  assert.equal(fixture.stats.metadataChanges, 1);
});

test('invalid future records do not close a group and out-of-order changes do not touch metadata', (t) => {
  const fixture = setup(t);
  fixture.read([HEADER, row(1, TIME, 'original'),
    row(1, '2025-01-01 00:00:00', 'future', 'invalid'),
    row(1, '2023-01-01 00:00:00', 'past'),
    row(1, TIME, 'original'), row(2, TIME, 'original')].join('\n'));
  assert.equal(fixture.groups.length, 1);
  assert.equal(fixture.groups[0].count, 2);
  assert.equal(fixture.stats.metadataChanges, 0);
  assert.deepEqual(fixture.rejections().map((record) => [record.line, record.reason]), [
    [3, 'invalid-boolean'], [4, 'out-of-order-timestamp'], [5, 'duplicate-identical'],
  ]);
});

test('all safe sixteen-digit IDs and zero-padded equivalents remain exact', (t) => {
  const fixture = setup(t);
  const ids = ['1000000000000000', '8999999999999999', '9007199254740990', '0009007199254740991'];
  fixture.read([HEADER, ...ids.map((id) => row(id))].join('\n'));
  assert.deepEqual([...fixture.groups[0].ids.slice(0, ids.length)], ids.map(Number));
  assert.equal(fixture.stats.rejectedRecords, 0);
});

test('rejection raw excerpts stop at 200 characters', (t) => {
  const fixture = setup(t);
  fixture.read(`${HEADER}\n${'x'.repeat(500)}\n${row(1)}`);
  assert.equal(fixture.rejections()[0].raw, 'x'.repeat(200));
});
