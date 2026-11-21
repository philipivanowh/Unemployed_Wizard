// Helpers for the downtown area. The outlines and NPC spots live in area-data.ts
// (edit them visually at /area-editor.html).

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
