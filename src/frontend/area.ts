// The part of Montreal the event map is limited to: the Ville-Marie borough
// (downtown) and the Milton-Parc neighbourhood. Outlines come from
// OpenStreetMap (© OpenStreetMap contributors, ODbL), simplified. Points are [lat, lng].

interface DowntownArea {
  name: string;
  ring: [number, number][];
}

const DOWNTOWN_AREAS: DowntownArea[] = [
  {
    name: "Ville-Marie",
    ring: [
      [45.49451, -73.60296],
      [45.49011, -73.5672], [45.49423, -73.5638], 
      [45.53367, -73.54398], [45.5385, -73.54852],
      [45.53592, -73.56135], 
      [45.50886, -73.57099],
      [45.50822, -73.58012], [45.51041, -73.57869],
    ],
  },
  {
    name: "Milton-Parc",
    ring: [
      [45.50202, -73.58012], [45.50497, -73.57346], 
    ],
  },
];

/**
 * Places on land the NPC wanders between. The Ville-Marie outline also covers
 * the river and the islands, so random points inside it could land in the water.
 */
const DOWNTOWN_SPOTS: { name: string; lat: number; lng: number }[] = [
  { name: "Phillips Square", lat: 45.5034, lng: -73.569 },
  { name: "McGill Roddick Gates", lat: 45.5048, lng: -73.5772 },
  { name: "Place des Arts", lat: 45.5085, lng: -73.5665 },
  { name: "Dorchester Square", lat: 45.4999, lng: -73.5713 },
  { name: "Square Victoria", lat: 45.5017, lng: -73.5619 },
  { name: "Place d'Armes", lat: 45.5046, lng: -73.5573 },
  { name: "Place Jacques-Cartier", lat: 45.5077, lng: -73.553 },
  { name: "Berri-UQAM", lat: 45.5152, lng: -73.561 },
  { name: "Concordia Hall Building", lat: 45.4972, lng: -73.5789 },
  { name: "Bell Centre", lat: 45.4961, lng: -73.5693 },
  { name: "The Village", lat: 45.5194, lng: -73.5555 },
  { name: "Milton-Parc", lat: 45.5095, lng: -73.575 },
];

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

/** A random spot near one of DOWNTOWN_SPOTS (within about 150 m), always inside the area. */
function randomDowntownPoint(): [number, number] {
  for (let attempt = 0; attempt < 20; attempt++) {
    const spot = DOWNTOWN_SPOTS[Math.floor(Math.random() * DOWNTOWN_SPOTS.length)]!;
    const lat = spot.lat + (Math.random() - 0.5) * 0.0026;
    const lng = spot.lng + (Math.random() - 0.5) * 0.0038;
    if (isInDowntown(lat, lng)) return [lat, lng];
  }
  const fallback = DOWNTOWN_SPOTS[0]!;
  return [fallback.lat, fallback.lng];
}
