import { haversine, isEncounterDistance, LATITUDE_WINDOW } from './haversine.js';
import { classifyEncounter } from './classify-encounter.js';

// Receives one validated timestamp group with unique IDs. Never retains its arrays.
export function findEncounters(group, timings, sortState) {
  const { count, ids, lat, lon, meta, timestamp } = group;
  const order = sortState?.order ?? [];
  let resetOrder = !sortState || order.length !== count;
  if (sortState) {
    // Keep values, not references to the reader's reusable arrays.
    for (let i = 0; i < count; i++) {
      if (sortState.ids[i] !== ids[i]) resetOrder = true;
      sortState.ids[i] = ids[i];
    }
    sortState.ids.length = count;
  }
  if (resetOrder) {
    order.length = count;
    for (let i = 0; i < count; i++) order[i] = i;
  }
  for (let i = 1; i < count; i++) {
    const index = order[i];
    let j = i - 1;
    while (j >= 0 && lat[order[j]] > lat[index]) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = index;
  }
  const encounters = [];
  let genericWithVictim = 0;

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (lat[order[j]] - lat[order[i]] > LATITUDE_WINDOW) break;
      let a = order[i];
      let b = order[j];
      // The smaller ID must be point 1, including in the distance calculation.
      if (ids[a] > ids[b]) [a, b] = [b, a];
      const latA = lat[a];
      const lonA = lon[a];
      const latB = lat[b];
      const lonB = lon[b];

      const distance = haversine(latA, lonA, latB, lonB);
      if (isEncounterDistance(distance)) {
        const tipo = classifyEncounter(ids[a], meta[a], ids[b], meta[b]);
        if (tipo === 'generico' && (meta[a].isVictim || meta[b].isVictim)) {
          genericWithVictim++;
        }
        encounters.push({
          tipo,
          monitoradosEncontro: [ids[a], ids[b]],
          timestamp,
          posicoes: {
            [ids[a]]: { lat: latA, lon: lonA },
            [ids[b]]: { lat: latB, lon: lonB },
          },
          distanciaMetros: distance,
        });
      }

    }
  }
  encounters.sort((a, b) => a.monitoradosEncontro[0] - b.monitoradosEncontro[0]
    || a.monitoradosEncontro[1] - b.monitoradosEncontro[1]);
  return { encounters, genericWithVictim };
}
