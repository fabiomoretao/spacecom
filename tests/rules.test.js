import test from 'node:test';
import assert from 'node:assert/strict';
import { haversine, isEncounterDistance } from '../src/domain/haversine.js';
import { findEncounters } from '../src/domain/find-encounters.js';
import { row, run, TIMESTAMP, NEXT_TIMESTAMP } from './helpers.js';

test('Haversine uses Earth radius 6,371,000 m', () => {
  assert.equal(haversine(0, 0, 0, 0), 0);
  assert.equal(haversine(0, 0, 0, 180), Math.PI * 6_371_000);
  assert.ok(Math.abs(haversine(0, 0, 1, 0) - 111194.92664455874) < 1e-8);
  assert.ok(Math.abs(haversine(-10.07996, -37.08384, -10.07987, -37.08389)
    - 11.406788673336607) < 1e-8);
});

test('distance is strictly below 20 m, without rounding', t => {
  assert.equal(isEncounterDistance(0), true);
  assert.equal(isEncounterDistance(20 - 1e-12), true);
  assert.equal(isEncounterDistance(20), false);
  assert.equal(isEncounterDistance(20 + 1e-12), false);
  for (const distance of [19.999999, 20.000001]) {
    const lat = distance / 6_371_000 * 180 / Math.PI;
    assert.equal(run(t, [row(1), row(2, { lat })]).encounters.length, distance < 20 ? 1 : 0);
  }
});

test('generic encounters preserve the exact output schema and positions', t => {
  const { encounters } = run(t, [row(44, { lat: -10.07987, lon: -37.08389 }),
    row(40, { lat: -10.07996, lon: -37.08384 })]);
  assert.equal(encounters.length, 1);
  assert.deepEqual(encounters[0], {
    tipo: 'generico', monitoradosEncontro: [40, 44], timestamp: TIMESTAMP,
    posicoes: { 40: { lat: -10.07996, lon: -37.08384 }, 44: { lat: -10.07987, lon: -37.08389 } },
    distanciaMetros: haversine(-10.07996, -37.08384, -10.07987, -37.08389),
  });
});

test('faction requires the same nonempty identifier', t => {
  for (const [first, second, expected] of [['A', 'A', 'faccao'], ['A', 'B', 'generico'],
    ['', '', 'generico'], ['A', '', 'generico']]) {
    const { encounters } = run(t, [row(1, { faction: first }), row(2, { faction: second })]);
    assert.equal(encounters[0].tipo, expected);
  }
});

test('protective encounters require the listed aggressor, in either ID order', t => {
  for (const [victim, aggressor] of [[1, 2], [2, 1]]) {
    const { encounters } = run(t, [row(victim, { victim: true, restrictions: `"${aggressor},99"` }),
      row(aggressor), row(3)]);
    const protective = encounters.filter(e => e.tipo === 'protetiva');
    assert.equal(protective.length, 1);
    assert.deepEqual(protective[0].monitoradosEncontro, [1, 2]);
  }
  assert.equal(run(t, [row(1, { restrictions: '2' }), row(2)]).encounters[0].tipo, 'generico');
});

test('one classification per pair, with protective precedence over faction', t => {
  const { encounters } = run(t, [row(1, { faction: 'A', victim: true, restrictions: '2' }),
    row(2, { faction: 'A', victim: true, restrictions: '1' })]);
  assert.equal(encounters.length, 1);
  assert.equal(encounters[0].tipo, 'protetiva');
});

test('same coordinates at different timestamps never meet', t => {
  for (const time of [NEXT_TIMESTAMP, '2026-10-01 00:00:01']) {
    assert.deepEqual(run(t, [row(1), row(2, { time })]).encounters, []);
  }
});

test('each unordered pair appears once per timestamp, including repeated encounters', t => {
  const { encounters, stats } = run(t, [row(3), row(1), row(2), row(2),
    row(1, { time: NEXT_TIMESTAMP }), row(2, { time: NEXT_TIMESTAMP })]);
  assert.deepEqual(encounters.map(e => [e.timestamp, e.monitoradosEncontro]), [
    [TIMESTAMP, [1, 2]], [TIMESTAMP, [1, 3]], [TIMESTAMP, [2, 3]], [NEXT_TIMESTAMP, [1, 2]],
  ]);
  assert.equal(stats.rejections['duplicate-identical'], 1);
});

test('metadata changes apply to the timestamp of each position', t => {
  const { encounters } = run(t, [row(1, { faction: 'A' }), row(2, { faction: 'A' }),
    row(1, { time: NEXT_TIMESTAMP, faction: 'B' }), row(2, { time: NEXT_TIMESTAMP, faction: 'A' })]);
  assert.deepEqual(encounters.map(e => e.tipo), ['faccao', 'generico']);
});

test('latitude candidate window agrees with exhaustive pairs at poles and antimeridian', () => {
  let seed = 42;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  const state = { ids: [], order: [] };
  for (const [latitude, longitude] of [[0, 0], [89.99999, 179.99999], [-90, 0], [0, 179.99999]]) {
    for (const count of [80, 80, 65]) {
      const lat = Array.from({ length: count }, () => Math.max(-90, Math.min(90, latitude + (random() - .5) * .001)));
      const lon = Array.from({ length: count }, () => ((longitude + (random() - .5) * .001 + 540) % 360) - 180);
      const ids = Array.from({ length: count }, (_, i) => count - i);
      const group = { count, lat, lon, ids, timestamp: TIMESTAMP,
        meta: ids.map(() => ({ faction: '', isVictim: false, restrictions: new Set() })) };
      const expected = [];
      for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
        if (haversine(lat[a], lon[a], lat[b], lon[b]) < 20) expected.push([ids[b], ids[a]]);
      }
      expected.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      assert.deepEqual(findEncounters(group, undefined, state).encounters.map(e => e.monitoradosEncontro), expected);
    }
  }
});
