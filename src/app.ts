import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { HttpError } from "./errors.ts";
import { eventsRouter } from "./events/routes.ts";
import { geocodeRouter } from "./geocode-route.ts";
import { walkwaysRouter } from "./walkways.ts";

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));

  app.use("/uploads", express.static(config.uploadDir, { index: false, maxAge: "7d" }));

  // Frontend: public/index.html (event map), public/area-editor.html, and compiled scripts in public/js.
  app.use(express.static(config.publicDir));
  // Leaflet (map library) straight from the npm package.
  app.use("/vendor/leaflet", express.static(config.leafletDir, { maxAge: "7d" }));
  // leaflet-rotate (GPL-3.0) adds map rotation; see MAP_ROTATION in src/frontend/map.ts.
  app.use("/vendor/leaflet-rotate", express.static(config.leafletRotateDir, { maxAge: "7d" }));

  // "/" is the frontend, so the API overview lives at /api.
  app.get("/api", (_req, res) => {
    res.json({
      name: "Free stuff events API",
      endpoints: [
        "GET    /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50&offset=0",
        "GET    /api/events/:id",
        "POST   /api/events",
        "PATCH  /api/events/:id",
        "DELETE /api/events/:id",
        "DELETE /api/events/:id/pictures/:pictureId",
        "GET    /api/walkways?south=&west=&north=&east=",
        "GET    /api/geocode?q=address&viewbox=west,south,east,north",
        "GET    /api/health",
      ],
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/events", eventsRouter);
  app.use("/api/walkways", walkwaysRouter);
  app.use("/api/geocode", geocodeRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "Validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: err.message, field: err.field });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON body" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  return app;
}
