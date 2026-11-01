import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findEncounters } from '../src/domain/find-encounters.js';
import { bruteForce } from './helpers/brute-force.js';

function makeGroup(rows, timestamp = '2024-01-01 00:00:00') {
  return {
    timestamp,
    count: rows.length,
    ids: Float64Array.from(rows, (r) => r[0]),
    lat: Int32Array.from(rows, (r) => r[1]),
    lon: Int32Array.from(rows, (r) => r[2]),
    meta: rows.map((r) => r[3] ?? { faction: '', isVictim: false, restrictions: new Set() }),
  };
}

test('official pair coordinates survive scaling and reversed input order', () => {
  for (const name of ['respostas1.json', 'respostas2.json']) {
    const records = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
    for (const reference of records) {
      const ids = [...reference.monitoradosEncontro].sort((a, b) => a - b);
      const rows = ids.toReversed().map((id) => [id,
        Math.round(reference.posicoes[id].lat * 1e5),
        Math.round(reference.posicoes[id].lon * 1e5)]);
      const { encounters } = findEncounters(makeGroup(rows, reference.timestamp));
      assert.equal(encounters.length, 1);
      const record = encounters[0];
      assert.deepEqual(record.monitoradosEncontro, ids);
      assert.deepEqual(record.posicoes, reference.posicoes);
      assert.equal(record.timestamp, reference.timestamp);
      assert.ok(Math.abs(record.distanciaMetros - reference.distanciaMetros) < 1e-9);
    }
  }
});

test('empty and singleton groups produce no encounters', () => {
  for (const rows of [[], [[1, 0, 0]]]) {
    assert.deepEqual(findEncounters(makeGroup(rows)), { encounters: [], genericWithVictim: 0 });
  }
});

test('phase instrumentation preserves encounters, counters and input arrays', () => {
  const group = makeGroup([[2, 0, 0], [1, 1, 1], [3, 40, 40]]);
  const before = structuredClone(group);
  const timings = { sortAndScan: 0, haversineAndClassification: 0 };
  const actual = findEncounters(group, timings);
  assert.deepEqual(actual, bruteForce(group));
  assert.deepEqual(group, before);
  assert.ok(timings.sortAndScan >= 0);
  assert.ok(timings.haversineAndClassification >= 0);
});

test('latitude window includes seventeen units but rejects eighteen and nineteen', () => {
  for (const [delta, expectedCount] of [[17, 1], [18, 0], [19, 0]]) {
    const group = makeGroup([[2, 0, 0], [1, delta, 0]]);
    assert.equal(findEncounters(group).encounters.length, expectedCount);
    assert.deepEqual(findEncounters(group), bruteForce(group));
  }
});

test('longitude distance rejects candidates inside the latitude window', () => {
  assert.equal(findEncounters(makeGroup([[1, 0, 0], [2, 0, 18]])).encounters.length, 0);
});

test('canonical order, large safe IDs, active count and copied output', () => {
  const ids = [Number.MAX_SAFE_INTEGER, 0, 4_294_967_296];
  const group = makeGroup(ids.map((id) => [id, 10, -10]));
  group.count = 2;
  assert.equal(findEncounters(group).encounters.length, 1);
  group.count = 3;
  const before = structuredClone(group);
  const result = findEncounters(group);
  assert.deepEqual(group, before);
  assert.deepEqual(result.encounters.map((e) => e.monitoradosEncontro), [
    [0, 4_294_967_296], [0, Number.MAX_SAFE_INTEGER], [4_294_967_296, Number.MAX_SAFE_INTEGER],
  ]);
  assert.deepEqual(Object.keys(result.encounters[2].posicoes), ['4294967296', '9007199254740991']);
  group.ids.fill(42);
  group.lat.fill(99);
  group.lon.fill(99);
  assert.deepEqual(result.encounters[0].posicoes[0], { lat: 0.0001, lon: -0.0001 });
  assert.deepEqual(result.encounters[0].monitoradosEncontro, [0, 4_294_967_296]);
});

test('separate timestamps and metadata snapshots stay independent', () => {
  const victim = { faction: '', isVictim: true, restrictions: new Set([2]) };
  const first = makeGroup([[1, 0, 0, victim], [2, 0, 0]]);
  const second = makeGroup([[1, 0, 0, { ...victim, restrictions: new Set() }], [2, 0, 0]],
    '2024-01-01 00:00:01');
  assert.equal(findEncounters(first).encounters[0].tipo, 'protetiva');
  const result = findEncounters(second);
  assert.equal(result.encounters[0].tipo, 'generico');
  assert.equal(result.encounters[0].timestamp, second.timestamp);
  assert.equal(result.genericWithVictim, 1);
  assert.equal(findEncounters(first).genericWithVictim, 0);
  assert.equal(findEncounters(makeGroup([[1, 0, 0]])).encounters.length, 0);
  assert.equal(findEncounters(makeGroup([[2, 0, 0]], second.timestamp)).encounters.length, 0);
});

test('generic victim counter counts pairs once and excludes faction encounters', () => {
  const victim = { faction: '', isVictim: true, restrictions: new Set() };
  assert.equal(findEncounters(makeGroup([[1, 0, 0, victim], [2, 0, 0, victim], [3, 0, 0]]))
    .genericWithVictim, 3);
  const factionVictim = { ...victim, faction: '1' };
  assert.equal(findEncounters(makeGroup([[1, 0, 0, factionVictim], [2, 0, 0, factionVictim]]))
    .genericWithVictim, 0);
});

test('antimeridian and polar encounters match the oracle', () => {
  for (const rows of [
    [[2, 0, 17_999_999], [1, 0, -17_999_999]],
    [[2, 8_999_999, 0], [1, 8_999_999, 18_000_000]],
    [[2, -8_999_999, 0], [1, -8_999_999, -18_000_000]],
  ]) {
    const group = makeGroup(rows);
    assert.equal(findEncounters(group).encounters.length, 1);
    assert.deepEqual(findEncounters(group), bruteForce(group));
  }
});

test('latitude sweep matches brute force in 4000 deterministic varied groups', () => {
  let seed = 0x12345678;
  const random = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let iteration = 0; iteration < 4000; iteration++) {
    const count = random(41);
    const mode = iteration % 4;
    const baseLat = random(17_000_001) - 8_500_000;
    const baseLon = random(35_000_001) - 17_500_000;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const id = (count - i) * 7 + iteration % 7;
      const lat = mode === 0 ? random(18_000_001) - 9_000_000
        : baseLat + random(mode === 1 ? 9 : 41) - 20;
      const lon = mode === 0 ? random(36_000_001) - 18_000_000
        : baseLon + random(mode === 1 ? 9 : 41) - 20;
      rows.push([id, lat, lon, {
        faction: ['', '1', '01', '2'][random(4)],
        isVictim: random(3) === 0,
        restrictions: new Set(random(2) ? [(count - random(count)) * 7 + iteration % 7] : []),
      }]);
    }
    const group = makeGroup(rows);
    const actual = findEncounters(group);
    const expected = bruteForce(group);
    assert.equal(actual.genericWithVictim, expected.genericWithVictim, `group ${iteration}`);
    assert.equal(actual.encounters.length, expected.encounters.length, `group ${iteration}`);
    for (let i = 0; i < actual.encounters.length; i++) {
      const { distanciaMetros: distance, ...record } = actual.encounters[i];
      const { distanciaMetros: reference, ...expectedRecord } = expected.encounters[i];
      assert.deepEqual(record, expectedRecord, `group ${iteration}, pair ${i}`);
      assert.ok(Math.abs(distance - reference) < 1e-9, `group ${iteration}, pair ${i}`);
    }
  }
});
