import { Router } from "express";
import { z } from "zod";
import { HttpError } from "./errors.ts";
import { geocodeAddress, geocodingEnabled, suggestAddresses } from "./geocode.ts";

// GET /api/geocode?q=<address>
// Lets the Add Event form show where an address lands before saving. Searches stay in
// Montreal and prefer the match nearest McGill (see geocode.ts). Lookups share one rate-
// limited, cached queue, so call it when a field is done, not on every keystroke.

const querySchema = z.object({
  q: z.string().trim().min(1, "Enter an address").max(300),
});

export const geocodeRouter = Router();

// GET /api/geocode/suggest?q=<partial address or McGill building>
// Suggestions while typing: { suggestions: [{ label, detail, address, latitude, longitude, kind }], complete }.
// McGill buildings ("Trottier", "SSMU", "Mac Eng") come first and need no geocoder.
const suggestSchema = z.object({ q: z.string().trim().max(300).default("") });

geocodeRouter.get("/suggest", async (req, res) => {
  const { q } = suggestSchema.parse(req.query);
  res.json(await suggestAddresses(q));
});

geocodeRouter.get("/", async (req, res) => {
  const { q } = querySchema.parse(req.query);
  // McGill buildings are found even with the geocoder off; other addresses need it.
  const result = await geocodeAddress(q);
  if (!result && !geocodingEnabled()) throw new HttpError(503, "Address lookup is turned off (GEOCODER_URL=off)");
  if (!result) throw new HttpError(404, "Couldn't find that address");
  res.json(result);
});
