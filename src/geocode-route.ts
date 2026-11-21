import { Router } from "express";
import { z } from "zod";
import { HttpError } from "./errors.ts";
import { geocodeAddress, geocodingEnabled } from "./geocode.ts";

// GET /api/geocode?q=<address>
// Lets the Add Event form show where an address lands before saving. Searches stay in
// Montreal and prefer the match nearest McGill (see geocode.ts). Lookups share one rate-
// limited, cached queue, so call it when a field is done, not on every keystroke.

const querySchema = z.object({
  q: z.string().trim().min(1, "Enter an address").max(300),
});

export const geocodeRouter = Router();

geocodeRouter.get("/", async (req, res) => {
  if (!geocodingEnabled()) throw new HttpError(503, "Address lookup is turned off (GEOCODER_URL=off)");
  const { q } = querySchema.parse(req.query);
  const result = await geocodeAddress(q);
  if (!result) throw new HttpError(404, "Couldn't find that address");
  res.json(result);
});
