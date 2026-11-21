import { Router } from "express";
import { z } from "zod";
import { HttpError } from "./errors.ts";
import { geocodeAddress, geocodingEnabled, type Viewbox } from "./geocode.ts";

// GET /api/geocode?q=<address>&viewbox=west,south,east,north
// Lets the Add Event form show where an address lands before saving. Lookups go through
// the shared Nominatim queue (1 per second, cached), so call it when a field is done,
// not on every keystroke.

const querySchema = z.object({
  q: z.string().trim().min(1, "Enter an address").max(300),
  viewbox: z
    .string()
    .regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/, "viewbox is west,south,east,north")
    .transform((s) => s.split(",").map(Number) as Viewbox)
    .optional(),
});

export const geocodeRouter = Router();

geocodeRouter.get("/", async (req, res) => {
  if (!geocodingEnabled()) throw new HttpError(503, "Address lookup is turned off (GEOCODER_URL=off)");
  const { q, viewbox } = querySchema.parse(req.query);
  const result = await geocodeAddress(q, viewbox);
  if (!result) throw new HttpError(404, "Couldn't find that address");
  res.json(result);
});
