import { haversine, ENCOUNTER_DISTANCE_METERS } from '../../src/domain/haversine.js';
import { classifyEncounter } from '../../src/domain/classify-encounter.js';

// Independent candidate enumeration: every unordered pair, without latitude pruning.
export function bruteForce(group) {
  const encounters = [];
  let genericWithVictim = 0;
  for (let i = 0; i < group.count; i++) {
    for (let j = i + 1; j < group.count; j++) {
      const [a, b] = group.ids[i] < group.ids[j] ? [i, j] : [j, i];
      const idA = group.ids[a];
      const idB = group.ids[b];
      const positionA = { lat: group.lat[a] / 1e5, lon: group.lon[a] / 1e5 };
      const positionB = { lat: group.lat[b] / 1e5, lon: group.lon[b] / 1e5 };
      const distance = haversine(positionA.lat, positionA.lon, positionB.lat, positionB.lon);
      if (distance < ENCOUNTER_DISTANCE_METERS) {
        const tipo = classifyEncounter(idA, group.meta[a], idB, group.meta[b]);
        if (tipo === 'generico' && (group.meta[a].isVictim || group.meta[b].isVictim)) {
          genericWithVictim++;
        }
        encounters.push({
          tipo,
          monitoradosEncontro: [idA, idB],
          timestamp: group.timestamp,
          posicoes: { [idA]: positionA, [idB]: positionB },
          distanciaMetros: distance,
        });
      }
    }
  }
  encounters.sort((a, b) => a.monitoradosEncontro[0] - b.monitoradosEncontro[0]
    || a.monitoradosEncontro[1] - b.monitoradosEncontro[1]);
  return { encounters, genericWithVictim };
}
