// Assumption A1: generic encounters involving victims are not officially confirmed.
const GENERIC_WITH_VICTIM_TYPE = 'generico';

export function classifyEncounter(idA, metaA, idB, metaB) {
  if ((metaA.isVictim && !metaB.isVictim && metaA.restrictions.has(idB))
    || (metaB.isVictim && !metaA.isVictim && metaB.restrictions.has(idA))) {
    return 'protetiva';
  }
  if (metaA.faction !== '' && metaA.faction === metaB.faction) {
    return 'faccao';
  }
  if (metaA.isVictim || metaB.isVictim) return GENERIC_WITH_VICTIM_TYPE;
  return 'generico';
}
