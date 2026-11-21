import { Router, type Request } from "express";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { geocodeAddress } from "../geocode.js";
import { deleteUploads, eventImagesUpload, getUploadedImages, uploadUrl } from "../uploads.js";
import * as repo from "./repository.js";
import { createEventSchema, listEventsQuerySchema, updateEventSchema } from "./validation.js";

export const eventsRouter = Router();

/** Shape returned to clients: filenames become URLs. */
function serialize(event: repo.EventRecord) {
  const { thumbnail, pictures, ...rest } = event;
  return {
    ...rest,
    thumbnailUrl: thumbnail ? uploadUrl(thumbnail) : null,
    pictures: pictures.map((p) => ({ id: p.id, url: uploadUrl(p.filename) })),
  };
}

function assertTimeOrder(startTime: string, endTime: string | null): void {
  if (endTime !== null && endTime <= startTime) {
    throw new HttpError(400, "Validation failed", [
      { path: "endTime", message: "endTime must be after startTime" },
    ]);
  }
}

/** latitude and longitude only make sense together. */
function assertCoordinatePair(latitude: number | null | undefined, longitude: number | null | undefined): void {
  if ((latitude === undefined) !== (longitude === undefined) || (latitude === null) !== (longitude === null)) {
    throw new HttpError(400, "Validation failed", [
      { path: "latitude", message: "Send latitude and longitude together" },
    ]);
  }
}

function eventId(req: Request): string {
  return String(req.params.id);
}

/**
 * Runs `fn`; if it throws, deletes the images uploaded in this request so
 * failed requests don't leave orphaned files behind.
 */
async function withUploadCleanup<T>(req: Request, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await deleteUploads(getUploadedImages(req).all);
    throw err;
  }
}

// GET /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50&offset=0
eventsRouter.get("/", (req, res) => {
  const query = listEventsQuerySchema.parse(req.query);
  const { events, total } = repo.listEvents(query);
  res.json({ events: events.map(serialize), total, limit: query.limit, offset: query.offset });
});

// GET /api/events/:id
eventsRouter.get("/:id", (req, res) => {
  const event = repo.getEvent(eventId(req));
  if (!event) throw new HttpError(404, "Event not found");
  res.json(serialize(event));
});

// POST /api/events  (multipart/form-data or JSON)
eventsRouter.post("/", eventImagesUpload, async (req, res) => {
  const event = await withUploadCleanup(req, async () => {
    const { latitude, longitude, ...input } = createEventSchema.parse(req.body ?? {});
    assertCoordinatePair(latitude, longitude);
    assertTimeOrder(input.startTime, input.endTime ?? null);

    // Use coordinates sent by the client, otherwise look the address up.
    const coords =
      latitude != null && longitude != null ? { latitude, longitude } : await geocodeAddress(input.address);
    const fields: repo.EventFields = {
      ...input,
      endTime: input.endTime ?? null,
      roomNumber: input.roomNumber ?? null,
      description: input.description ?? "",
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
    };

    const images = getUploadedImages(req);
    return repo.createEvent(fields, { thumbnail: images.thumbnail ?? null, pictures: images.pictures });
  });
  res.status(201).location(`/api/events/${event.id}`).json(serialize(event));
});

// PATCH /api/events/:id  (multipart/form-data or JSON; all fields optional)
// - `thumbnail` file replaces the thumbnail; `removeThumbnail=true` clears it.
// - `pictures` files are appended; `removePictureIds` deletes existing ones.
// - `latitude`/`longitude` set the location; a new `address` without them is looked up again.
eventsRouter.patch("/:id", eventImagesUpload, async (req, res) => {
  const result = await withUploadCleanup(req, async () => {
    const { removePictureIds = [], removeThumbnail, latitude, longitude, ...patch } = updateEventSchema.parse(
      req.body ?? {},
    );
    assertCoordinatePair(latitude, longitude);
    const id = eventId(req);
    const existing = repo.getEvent(id);
    if (!existing) throw new HttpError(404, "Event not found");

    const unknownIds = removePictureIds.filter((pid) => !existing.pictures.some((p) => p.id === pid));
    if (unknownIds.length) {
      throw new HttpError(400, "Some pictures do not belong to this event", { unknownPictureIds: unknownIds });
    }

    const images = getUploadedImages(req);
    const pictureCount =
      existing.pictures.length - new Set(removePictureIds).size + images.pictures.length;
    if (pictureCount > config.maxPicturesPerEvent) {
      throw new HttpError(400, `An event can have at most ${config.maxPicturesPerEvent} pictures`);
    }

    assertTimeOrder(
      patch.startTime ?? existing.startTime,
      patch.endTime !== undefined ? patch.endTime : existing.endTime,
    );

    let location: Partial<Pick<repo.EventFields, "latitude" | "longitude">> = {};
    if (latitude !== undefined) {
      location = { latitude, longitude };
    } else if (patch.address !== undefined && patch.address !== existing.address) {
      const coords = await geocodeAddress(patch.address);
      location = { latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null };
    }

    return repo.updateEvent(id, { ...patch, ...location }, {
      thumbnail: images.thumbnail ?? (removeThumbnail ? null : undefined),
      addPictures: images.pictures,
      removePictureIds,
    })!;
  });

  // Committed: now it's safe to remove files that are no longer referenced.
  await deleteUploads(result.orphanedFiles);
  res.json(serialize(result.event));
});

// DELETE /api/events/:id
eventsRouter.delete("/:id", async (req, res) => {
  const files = repo.deleteEvent(eventId(req));
  if (!files) throw new HttpError(404, "Event not found");
  await deleteUploads(files);
  res.status(204).end();
});

// DELETE /api/events/:id/pictures/:pictureId
eventsRouter.delete("/:id/pictures/:pictureId", async (req, res) => {
  const id = eventId(req);
  const pictureId = String(req.params.pictureId);
  const existing = repo.getEvent(id);
  if (!existing) throw new HttpError(404, "Event not found");
  if (!existing.pictures.some((p) => p.id === pictureId)) throw new HttpError(404, "Picture not found");

  const result = repo.updateEvent(id, {}, { removePictureIds: [pictureId] })!;
  await deleteUploads(result.orphanedFiles);
  res.json(serialize(result.event));
});
