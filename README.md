# Unemployed_Wizard

Backend for a free food / free stuff events app. TypeScript + Express 5, SQLite
(Node's built-in `node:sqlite`, so there are no native modules to compile), and images stored on local disk.

## Setup

Requires **Node.js 23.6+**. Node runs the backend TypeScript directly, so the server has no build step.
The browser code in `src/frontend/` does get compiled, which `npm run dev` and `npm start` do for you.

```sh
npm install
npm run dev        # restarts on file changes, http://localhost:3000
npm start          # builds the frontend, then runs node src/index.ts
npm run typecheck  # Node strips types without checking them, so run this too
```

You can run it from any folder (`node src/index.ts`, or `node index.ts` inside `src/`).
The `data/` and `uploads/` folders are always created in the project root.

Environment variables (all optional):

| Var           | Default        | Purpose                         |
| ------------- | -------------- | ------------------------------- |
| `PORT`        | `3000`         | HTTP port                       |
| `DB_PATH`     | `data/app.db`  | SQLite database file            |
| `UPLOAD_DIR`  | `uploads`      | Where uploaded images are saved |
| `CORS_ORIGIN` | `*`            | Allowed CORS origin             |
| `GEOCODER_URL` | `https://nominatim.openstreetmap.org` | Nominatim server for address lookups (`off` disables) |
| `GEOCODER_USER_AGENT` | `UnemployedWizard/0.1 (…)` | Identifies the app to Nominatim; add contact info for production |

## Frontend

- `http://localhost:3000/`: the canvas (`src/frontend/world.ts`, `npc.ts`).
- `http://localhost:3000/map.html`: upcoming events in downtown Montreal (Ville-Marie and Milton-Parc) on an
  OpenStreetMap map drawn with Leaflet, with the NPC roaming around (`src/frontend/map.ts`, `area.ts`).
- `http://localhost:3000/api`: a list of the API endpoints.

`src/frontend/*.ts` compiles to `public/js/`, and `npm run dev` rebuilds it as you edit.

## Locations

Events have `latitude` and `longitude`. If you don't send them, the server looks up the `address` with
[Nominatim](https://nominatim.org/) (OpenStreetMap's free geocoder) when the event is created or its address
changes. Lookups are limited to 1 per second and cached, as Nominatim's usage policy requires. Use full addresses
with city and state, like `77 Massachusetts Ave, Cambridge, MA`, because a bare street can match the wrong town.
When an address can't be found, both coordinates are `null`. At startup the server retries events that have
no location.

## Event shape

```json
{
  "id": "6f1c…",
  "title": "Pizza after the CS talk",
  "date": "2026-12-03",
  "startTime": "17:30",
  "endTime": "19:00",
  "address": "123 College Ave",
  "roomNumber": "B201",
  "freeItems": ["Pizza", "Soda", "T-shirts"],
  "description": "Leftover pizza from the guest lecture.",
  "latitude": 42.3594,
  "longitude": -71.0938,
  "thumbnailUrl": "/uploads/1a2b….jpg",
  "pictures": [{ "id": "9e8d…", "url": "/uploads/3c4d….png" }],
  "createdAt": "2026-11-21T17:00:00.000Z",
  "updatedAt": "2026-11-21T17:00:00.000Z"
}
```

- `date` is `YYYY-MM-DD`. `startTime` and `endTime` are 24-hour `HH:MM`. `endTime` and `roomNumber` are optional.
- Images must be JPEG, PNG, WebP or GIF, 10 MB max each, with up to 20 extra pictures per event.
- Image URLs are relative to the server, e.g. `http://localhost:3000/uploads/…`.

## API

| Method   | Path                                    | Description                     |
| -------- | --------------------------------------- | ------------------------------- |
| `GET`    | `/api/events?from=&to=&limit=&offset=`  | List events sorted by date/time |
| `GET`    | `/api/events/:id`                       | Get one event                   |
| `POST`   | `/api/events`                           | Create an event                 |
| `PATCH`  | `/api/events/:id`                       | Edit an event (partial)         |
| `DELETE` | `/api/events/:id`                       | Delete an event and its images  |
| `DELETE` | `/api/events/:id/pictures/:pictureId`   | Delete one extra picture        |

`POST` and `PATCH` accept `multipart/form-data` (needed for images) or JSON.

Form fields: `title`, `date`, `startTime`, `endTime`, `address`, `roomNumber`,
`freeItems`, `description`, `latitude`, `longitude`. Send `latitude` and `longitude` together, or leave both out
to look up the address. You can send `freeItems` as a JSON array (`["Pizza","Soda"]`),
as a comma-separated string (`Pizza, Soda`), or as a repeated field.

File fields: `thumbnail` (one image) and `pictures` (multiple images).

`PATCH` extras:
- Send a new `thumbnail` file to replace the thumbnail, or `removeThumbnail=true` to clear it.
- Uploaded `pictures` are **added** to the existing ones.
- `removePictureIds` deletes existing pictures. It takes a JSON array or a comma-separated list.
- An empty `endTime` or `roomNumber` clears that field.

### Examples

```sh
# Create
curl -X POST http://localhost:3000/api/events \
  -F title="Bagels in the lounge" -F date=2026-12-01 -F startTime=09:00 -F endTime=10:30 \
  -F address="1 Main St" -F roomNumber=101 -F freeItems="Bagels, Coffee" \
  -F description="First come first served" \
  -F thumbnail=@bagels.jpg -F pictures=@lounge1.jpg -F pictures=@lounge2.jpg

# Edit
curl -X PATCH http://localhost:3000/api/events/<id> \
  -H "Content-Type: application/json" \
  -d '{"endTime":"11:00","freeItems":["Bagels","Coffee","Juice"]}'

# Delete
curl -X DELETE http://localhost:3000/api/events/<id>
```

Errors come back as `{ "error": string, "details"?: … }`. The status codes are 400 for a validation error,
404 when an event isn't found, and 413 when an image is too large.
