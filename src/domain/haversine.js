const R = 6_371_000;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

export const ENCOUNTER_DISTANCE_METERS = 20;
export const isEncounterDistance = distance => distance < ENCOUNTER_DISTANCE_METERS;
// Conservative margin applies only to candidate selection, never to distance.
export const LATITUDE_WINDOW = 20 / R * 180 / Math.PI + 1e-12;

export function haversine(lat1, lon1, lat2, lon2) {
  // Convert differences in degrees to preserve the official numerical variant.
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2))
    * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
