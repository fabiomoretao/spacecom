import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { haversine } from '../src/domain/haversine.js';

test('environment reproduces all ten official distances with strict equality', () => {
  let count = 0;
  for (const name of ['respostas1.json', 'respostas2.json']) {
    const records = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
    for (const record of records) {
      const [idA, idB] = [...record.monitoradosEncontro].sort((a, b) => a - b);
      const a = record.posicoes[idA];
      const b = record.posicoes[idB];
      const distance = haversine(a.lat, a.lon, b.lat, b.lon);
      assert.ok(distance === record.distanciaMetros, `${name}: ${idA}, ${idB}`);
      count++;
    }
  }
  assert.equal(count, 10);
});

test('identical positions have zero distance', () => {
  assert.ok(Math.abs(haversine(-31.93195, -40.61438, -31.93195, -40.61438)) < 1e-9);
});

test('distances immediately below, at and above twenty meters', () => {
  for (const meters of [20 - 1e-6, 20, 20 + 1e-6]) {
    const latitude = (meters / 6_371_000) * 180 / Math.PI;
    const distance = haversine(0, 0, latitude, 0);
    assert.ok(Math.abs(distance - meters) < 1e-9);
    if (meters < 20) assert.ok(distance < 20);
    if (meters > 20) assert.ok(distance > 20);
  }
});

test('distance works across the antimeridian and near the poles', () => {
  assert.ok(Math.abs(haversine(0, 179.99999, 0, -179.99999)
    - 6_371_000 * 0.00002 * Math.PI / 180) < 1e-9);
  assert.ok(haversine(89.99999, 0, 89.99999, 180) < 3);
});
