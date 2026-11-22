// The part of Montreal the event map is limited to, plus the places the NPC wanders to.
// Original outlines: OpenStreetMap (© OpenStreetMap contributors, ODbL). Points are [lat, lng].

interface DowntownArea {
  name: string;
  ring: [number, number][];
}

const DOWNTOWN_AREAS: DowntownArea[] = [
  {
    // A box square to the street grid: Rue de la Montagne (left), Rue Jeanne-Mance (right),
    // Avenue Duluth Ouest (top) and Boulevard De Maisonneuve Ouest (bottom), each street
    // included plus 10 m. The top-left corner is on Mount Royal, where the two streets would meet.
    name: "Region",
    ring: [
      [45.50546, -73.5908], [45.51469, -73.58157], [45.50787, -73.56766], [45.49863, -73.57688],
    ],
  },
];

/** Places on land the NPC wanders between (random points could land in the river). */
const DOWNTOWN_SPOTS: { name: string; lat: number; lng: number }[] = [
  { name: "Phillips Square", lat: 45.5034, lng: -73.569 },
  { name: "McGill Roddick Gates", lat: 45.5048, lng: -73.5772 },
  { name: "Dorchester Square", lat: 45.4999, lng: -73.5713 },
  { name: "Square Victoria", lat: 45.5017, lng: -73.5619 },
  { name: "Place d'Armes", lat: 45.5046, lng: -73.5573 },
  { name: "Place Jacques-Cartier", lat: 45.5077, lng: -73.553 },
];