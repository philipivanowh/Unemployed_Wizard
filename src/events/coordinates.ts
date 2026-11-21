import { geocodeAddress, geocodingEnabled } from "../geocode.ts";
import * as repo from "./repository.ts";

/**
 * Looks up coordinates for events saved without them (for example, created before
 * the map existed, or while the geocoder was unreachable). Runs in the background
 * at the geocoder's rate limit.
 */
export async function backfillEventCoordinates(): Promise<void> {
  if (!geocodingEnabled()) return;
  const missing = repo.eventsMissingCoordinates();
  if (missing.length === 0) return;

  let found = 0;
  for (const { id, address } of missing) {
    const coords = await geocodeAddress(address);
    if (coords) {
      repo.setCoordinates(id, address, coords.latitude, coords.longitude);
      found++;
    }
  }
  console.log(`Geocoded ${found} of ${missing.length} events that had no location`);
}
