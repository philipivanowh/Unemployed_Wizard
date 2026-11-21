// The part of Montreal the event map is limited to, plus the places the NPC wanders to.
// Edit this visually at /area-editor.html, then paste its output over this whole file.
// Original outlines: OpenStreetMap (© OpenStreetMap contributors, ODbL). Points are [lat, lng].

interface DowntownArea {
  name: string;
  ring: [number, number][];
}

const DOWNTOWN_AREAS: DowntownArea[] = [
  {
    name: "Region",
     ring: [
      [45.50141, -73.58004], [45.50293, -73.58314], [45.505, -73.58697], [45.5087, -73.58312],
      [45.51218, -73.57975], [45.50824, -73.57116], [45.50697, -73.56827], [45.50277, -73.57253],
      [45.49974, -73.57614],
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