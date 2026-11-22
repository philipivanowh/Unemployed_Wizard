// McGill's downtown campus buildings, so people can type a building name (or a nickname
// like "SSMU" or "Mac Eng") instead of its street address. Coordinates come from
// OpenStreetMap (© OpenStreetMap contributors, ODbL). To add a building, add a line:
// the official name, its street address, [lat, lng], and any names people use for it.

export interface McGillBuilding {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  aliases: string[];
}

const b = (name: string, address: string, [latitude, longitude]: [number, number], aliases: string[] = []): McGillBuilding => ({
  name,
  address,
  latitude,
  longitude,
  aliases,
});

export const MCGILL_BUILDINGS: McGillBuilding[] = [
  // Teaching and research
  b("Arts Building", "853 Sherbrooke St W", [45.50528, -73.57769], ["Arts", "Moyse Hall"]),
  b("Leacock Building", "855 Sherbrooke St W", [45.50462, -73.5782], ["Leacock", "Stephen Leacock"]),
  b("Burnside Hall", "805 Sherbrooke St W", [45.50472, -73.57494], ["Burnside"]),
  b("Otto Maass Chemistry Building", "801 Sherbrooke St W", [45.50483, -73.57414], ["Otto Maass", "Maass", "Chemistry"]),
  b("Rutherford Physics Building", "3600 University St", [45.50704, -73.57847], ["Rutherford", "Physics"]),
  b("Macdonald Engineering Building", "817 Sherbrooke St W", [45.50556, -73.57643], ["Mac Eng", "MacDonald Eng", "Engineering"]),
  b("McConnell Engineering Building", "3480 University St", [45.50598, -73.57615], ["McConnell Eng", "McConnell", "ECE"]),
  b("Macdonald-Harrington Building", "815 Sherbrooke St W", [45.50536, -73.57574], ["Macdonald Harrington", "Architecture"]),
  b("Frank Dawson Adams Building", "3450 University St", [45.5055, -73.57521], ["Adams Building", "FDA", "Dawson Adams"]),
  b("Wong Building", "3610 University St", [45.50661, -73.57875], ["Wong"]),
  b("Trottier Building", "3630 University St", [45.50738, -73.57903], ["Trottier", "Computer Science"]),
  b("Trottier Space Institute", "3550 University St", [45.50685, -73.57786], ["TSI"]),
  b("Stewart Biology Building", "1205 Dr Penfield Ave", [45.50261, -73.58095], ["Stewart Bio", "Biology"]),
  b("Bronfman Building", "1001 Sherbrooke St W", [45.50254, -73.57645], ["Bronfman", "Desautels", "Management"]),
  b("Strathcona Anatomy & Dentistry Building", "3640 University St", [45.50749, -73.57986], ["Strathcona Anatomy", "Dentistry", "Anatomy"]),
  b("McIntyre Medical Building", "3655 Promenade Sir-William-Osler", [45.50303, -73.58254], ["McIntyre", "McMed", "Medicine"]),
  b("Duff Medical Building", "3775 University St", [45.50873, -73.58079], ["Lyman Duff", "Duff"]),
  b("Education Building", "3700 McTavish St", [45.50438, -73.58042], ["Education", "Faculty of Education"]),
  b("Chancellor Day Hall", "3644 Peel St", [45.50307, -73.58056], ["New Chancellor Day Hall", "Law", "NCDH", "Faculty of Law"]),
  b("Elizabeth Wirth Music Building", "527 Sherbrooke St W", [45.50634, -73.57323], ["New Music Building", "Wirth", "Music"]),
  b("Strathcona Music Building", "555 Sherbrooke St W", [45.50594, -73.57327], ["Schulich School of Music", "Pollack Hall"]),
  b("Pulp & Paper Research Centre", "3420 University St", [45.50528, -73.57478], ["Pulp and Paper", "Chemical Engineering"]),
  b("Genome Building", "740 Dr Penfield Ave", [45.50695, -73.5795], ["Genome", "Genome Quebec"]),
  b("Ferrier Building", "840 Dr Penfield Ave", [45.5056, -73.57802], ["Ferrier"]),
  b("Birks Building", "3520 University St", [45.50658, -73.57737], ["Birks", "Religious Studies"]),
  b("Morrice Hall", "3485 McTavish St", [45.50401, -73.5777], ["Morrice", "Islamic Studies Library"]),
  b("Charles Meredith House", "1130 Pine Ave W", [45.50391, -73.58212], ["Meredith House"]),
  b("Purvis Hall", "1020 Pine Ave W", [45.50462, -73.58141], ["Purvis"]),

  // Libraries and museum
  b("McLennan Library Building", "3459 McTavish St", [45.50327, -73.57594], ["McLennan", "McLennan Library", "Humanities Library"]),
  b("Redpath Library Building", "3461 McTavish St", [45.50356, -73.57673], ["Redpath Library", "Redpath", "Cyberthèque"]),
  b("Redpath Hall", "3461 McTavish St", [45.5038, -73.5773], ["Redpath Hall"]),
  b("Redpath Museum", "859 Sherbrooke St W", [45.50447, -73.57751], ["Redpath Museum", "Museum"]),
  b("Schulich Library of Science and Engineering", "809 Sherbrooke St W", [45.50507, -73.57532], ["Schulich Library", "Macdonald-Stewart Library", "Schulich"]),

  // Student life and administration
  b("University Centre", "3480 McTavish St", [45.50354, -73.57816], ["SSMU", "SSMU Building", "Shatner", "Student Union"]),
  b("Brown Student Services Building", "3600 McTavish St", [45.50358, -73.5788], ["Brown Building", "Brown", "Student Services"]),
  b("James Administration Building", "845 Sherbrooke St W", [45.50615, -73.57758], ["James Admin", "Admin Building"]),
  b("Thomson House", "3650 McTavish St", [45.50425, -73.57967], ["PGSS", "Thomson"]),
  b("Faculty Club", "3450 McTavish St", [45.50318, -73.57721], ["McGill Faculty Club"]),
  b("Peterson Hall", "3460 McTavish St", [45.50331, -73.57766], ["Peterson"]),
  b("Wilson Hall", "3506 University St", [45.50633, -73.57691], ["Wilson", "Social Work"]),
  b("Martlet House", "1430 Peel St", [45.50025, -73.57394], ["Maison Martlet"]),
  b("Roddick Gates", "Sherbrooke St W at McGill College Ave", [45.50385, -73.57492], ["Main Gates", "Roddick"]),

  // Sports
  b("McGill Sports Complex", "475 Pine Ave W", [45.51028, -73.57933], ["Currie Gym", "Currie Gymnasium", "Gym", "Sports Centre", "Fitness Centre"]),
  b("Tomlinson Field House", "475 Pine Ave W", [45.51079, -73.57956], ["Tomlinson", "Field House"]),
  b("Percival Molson Memorial Stadium", "475 Pine Ave W", [45.51023, -73.58079], ["Molson Stadium", "Stadium"]),

  // Residences
  b("Royal Victoria College", "3425 University St", [45.5055, -73.57411], ["RVC"]),
  b("New Residence Hall", "3625 Park Ave", [45.51089, -73.57601], ["New Rez", "New Res"]),
  b("La Citadelle", "410 Sherbrooke St W", [45.50726, -73.57146], ["Citadelle", "La Cit"]),
  b("Carrefour Sherbrooke", "475 Sherbrooke St W", [45.50676, -73.57262], ["Carrefour"]),
  b("Douglas Hall", "3851 University St", [45.51014, -73.58272], ["Douglas"]),
  b("McConnell Hall", "3905 University St", [45.51094, -73.58314], ["McConnell Residence"]),
  b("Molson Hall", "3915 University St", [45.51114, -73.58382], ["Molson Residence"]),
  b("Gardner Hall", "3925 University St", [45.51033, -73.58422], ["Gardner"]),
  b("Bishop Mountain Hall", "3935 University St", [45.51064, -73.58365], ["BMH", "Bishop Mountain"]),
];

// ---------------------------------------------------------------------------
// Matching

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Words that don't help tell buildings apart. "McGill Trottier" should find Trottier. */
const FILLER = new Set(["mcgill", "university", "universite", "building", "the", "of", "at", "montreal", "qc"]);

interface Indexed {
  building: McGillBuilding;
  names: { text: string; words: string[] }[];
}

const INDEX: Indexed[] = MCGILL_BUILDINGS.map((building) => ({
  building,
  names: [building.name, ...building.aliases].map((n) => {
    const text = normalize(n);
    return { text, words: text.split(" ") };
  }),
}));

/** How well `query` names this building: 0 (not at all) to 100 (exactly). */
function score(entry: Indexed, query: string, queryWords: string[]): number {
  let best = 0;
  for (const name of entry.names) {
    let s = 0;
    if (query === name.text) s = 100;
    // "trottier building 3630 university st": a saved suggestion that starts with the name.
    else if (query.startsWith(`${name.text} `)) s = 95;
    else if (name.text.startsWith(query)) s = 90 - Math.min(10, name.text.length - query.length) / 2;
    else if (queryWords.length > 0 && queryWords.every((q) => name.words.some((w) => w.startsWith(q)))) {
      // Every typed word starts a word of the name ("mac eng", "otto chem").
      s = 70 - Math.min(10, name.words.length - queryWords.length);
    }
    best = Math.max(best, s);
  }
  return best;
}

/** Buildings matching what was typed, with how well (0–100), best first. */
export function rankMcGillBuildings(text: string): { building: McGillBuilding; score: number }[] {
  const query = normalize(text);
  if (query.length < 2) return [];
  const words = query.split(" ").filter((w) => !FILLER.has(w));
  const cleaned = words.join(" ");
  return INDEX.map((entry) => ({
    building: entry.building,
    score: Math.max(score(entry, query, words), cleaned && cleaned !== query ? score(entry, cleaned, words) : 0),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.building.name.length - b.building.name.length);
}

/** McGill buildings that match what was typed, best first. */
export function matchMcGillBuildings(text: string, limit = 5): McGillBuilding[] {
  return rankMcGillBuildings(text)
    .slice(0, limit)
    .map((x) => x.building);
}

/** The building an address clearly names ("Trottier", "SSMU", "Trottier Building, 3630 University St"), if any. */
export function findMcGillBuilding(text: string): McGillBuilding | null {
  const best = rankMcGillBuildings(text)[0];
  return best && best.score >= 90 ? best.building : null;
}

/** "Trottier Building, 3630 University St": what goes in the address field. */
export function buildingAddressLine(building: McGillBuilding): string {
  return `${building.name}, ${building.address}`;
}
