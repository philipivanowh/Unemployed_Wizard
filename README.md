# Unemployed_Wizard

Backend for a free food / free stuff events app. TypeScript + Express 5, SQLite
(Node's built-in `node:sqlite`, so there are no native modules to compile), and images stored on local disk.

## Setup

Requires **Node.js 22.13+** (Node 24 LTS recommended).

```sh
npm install
npm run dev        # dev server with reload on http://localhost:3000
# or
npm run build && npm start
```

Environment variables (all optional):

| Var           | Default        | Purpose                         |
| ------------- | -------------- | ------------------------------- |
| `PORT`        | `3000`         | HTTP port                       |
| `DB_PATH`     | `data/app.db`  | SQLite database file            |
| `UPLOAD_DIR`  | `uploads`      | Where uploaded images are saved |
| `CORS_ORIGIN` | `*`            | Allowed CORS origin             |

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
`freeItems`, `description`. You can send `freeItems` as a JSON array (`["Pizza","Soda"]`),
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
