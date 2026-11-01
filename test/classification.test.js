import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEncounter } from '../src/domain/classify-encounter.js';

const meta = (faction = '', isVictim = false, restrictions = []) => ({
  faction, isVictim, restrictions: new Set(restrictions),
});

const cases = [
  ['same nonempty faction', meta('1'), meta('1'), 'faccao'],
  ['different factions', meta('1'), meta('2'), 'generico'],
  ['empty factions', meta(), meta(), 'generico'],
  ['opaque factions are not normalized', meta('01'), meta('1'), 'generico'],
  ['protective restriction overrides faction', meta('1', true, [2]), meta('1'), 'protetiva'],
  ['protective restriction in reverse direction', meta(), meta('', true, [1]), 'protetiva'],
  ['unrelated victim uses assumption A1', meta('', true, [3]), meta(), 'generico'],
  ['two restricted victims use assumption A1', meta('', true, [2]), meta('', true, [1]), 'generico'],
  ['two victims can share a faction', meta('1', true, [2]), meta('1', true, [1]), 'faccao'],
  ['victim with empty restrictions', meta('', true), meta(), 'generico'],
  ['inactive restriction is ignored', meta('', false, [2]), meta(), 'generico'],
  ['unrelated victim can share a faction', meta('1', true), meta('1'), 'faccao'],
];

for (const [name, a, b, expected] of cases) {
  test(name, () => {
    const before = structuredClone([a, b]);
    assert.equal(classifyEncounter(1, a, 2, b), expected);
    assert.equal(classifyEncounter(2, b, 1, a), expected);
    assert.deepEqual([a, b], before);
  });
}
