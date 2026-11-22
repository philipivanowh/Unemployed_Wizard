// Helpers for the downtown area. The outlines and NPC spots live in area-data.ts
// (edit that file to change them).

function isPointInRing(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i]!;
    const [latJ, lngJ] = ring[j]!;
    if (lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI) {
      inside = !inside;
    }
  }
  return inside;
}

function isInDowntown(lat: number, lng: number): boolean {
  return DOWNTOWN_AREAS.some((area) => isPointInRing(lat, lng, area.ring));
}

/**
 * Map rotation in degrees, clockwise: 0 keeps north up, 90 turns the map a quarter
 * turn clockwise, -30 tilts it 30° the other way. Pins, popups and the NPC stay upright.
 * Uses the leaflet-rotate add-on (GPL-3.0). The map editor uses it too, and saved map edits
 * are positioned on the rotated grid, so changing it moves edited buildings and tiles.
 */
const MAP_ROTATION = 55;
