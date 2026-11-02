export function classifyEncounter(idA, metaA, idB, metaB) {
  if ((metaA.isVictim && metaA.restrictions.has(idB))
    || (metaB.isVictim && metaB.restrictions.has(idA))) {
    return 'protetiva';
  }
  if (metaA.faction !== '' && metaA.faction === metaB.faction) {
    return 'faccao';
  }
  // Assumption A1: remaining pairs include victims; this is not officially confirmed.
  return 'generico';
}
