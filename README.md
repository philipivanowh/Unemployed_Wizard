# Unemployed_Wizard

McGill Free Food Tracker app that scrape Instagram and Facebook post using 3 Models of AI
MoonshotAI:vision model that analyze the post image and get event info
JEV AI: a System one model that chooses whether this post contains free things or not
KIMI: Summarize the analysis and put it into a json file.


## Setup

Requires **Node.js 23.6+**. `npm install`
The browser code in `src/frontend/` does get compiled, which `npm run dev` and `npm start` do for you.

Open two terminal 

Build the frontend
```sh
npm start          # builds the frontend, then runs node src/index.ts
```

Run the Scraper
`cd unemployed_wizard/src`
`python discovery.py`

You can run it from any folder (`node src/index.ts`, or `node index.ts` inside `src/`).
The `data/` and `uploads/` folders are always created in the project root.

Environment variables (all optional):

| Var           | Default        | Purpose                         |
| ------------- | -------------- | ------------------------------- |
| `PORT`        | `3000`         | HTTP port                       |
| `DB_PATH`     | `data/app.db`  | SQLite database file            |
| `UPLOAD_DIR`  | `uploads`      | Where uploaded images are saved |
| `CORS_ORIGIN` | `*`            | Allowed CORS origin             |
| `GEOCODER_URL` | `https://photon.komoot.io` | Photon server for address lookups (`off` disables) |
| `GEOCODER_USER_AGENT` | `UnemployedWizard/0.1 (…)` | Identifies the app to the geocoder; add contact info for production |
| `GEOCODER_BBOX` | `-73.98,45.40,-73.47,45.71` | Only match places in this box (`minLon,minLat,maxLon,maxLat`; Montreal by default; empty = anywhere) |
| `GEOCODER_CENTER` | `45.5048,-73.5772` | When several places match, use the one nearest this point (`lat,lon`; McGill by default) |
| `ADMIN_KEY` | generated, saved in the database | Key that unlocks the admin controls (see [Turning editing on and off](#turning-editing-on-and-off)) |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass server for walkway data (`off` disables it) |

## Frontend

- `http://localhost:3000/`: upcoming events on an OpenStreetMap map drawn with Leaflet (`src/frontend/map.ts`).
  It opens on the area box in `area-data.ts` (Rue de la Montagne to Rue Jeanne-Mance, Boulevard De Maisonneuve
  to Avenue Duluth), and you can't pan or zoom out past it; street-map tiles outside it aren't loaded. Inside it the
  map is drawn as pixel art (`pixel-world.ts`, art in `public/tiles/`, OpenStreetMap data from `/api/mapdata`), with
  street names from zoom 17 and building names from zoom 18 (`LABEL_STREET_ZOOM`, `LABEL_BUILDING_ZOOM`); hovering a
  building or street shows its name.
  Every event with a location gets a pin.
  **Back to McGill** (under the zoom buttons) returns to 845 Sherbrooke St W. Set `MAP_ROTATION` (degrees,
  clockwise) in `area.ts` to rotate it; moving it also moves the hand edits in `public/map-edits.json`. Rotation uses the
  [leaflet-rotate](https://github.com/Raruto/leaflet-rotate) add-on, which is licensed **GPL-3.0**.
- **Edit / Remove**: each event's popup has an **Edit** button, which opens the event in the add-event form, and a
  **Remove** button, which asks once more before deleting. Both appear only when editing is allowed
  (see [Turning editing on and off](#turning-editing-on-and-off)).
- **Townspeople**: pixel-art people walk the area's real paths and streets on a daily routine. They stay inside the
  area outline (`area-data.ts`), which is where walkway data is loaded. Crowds only gather at events inside it.
  - `npc.ts`: the sprites. Each person is built from 10 features (skin, eyes, hair, facial hair, top, bottoms,
    shoes, hat, glasses, bag), each with several styles and many colors, listed in `NPC_FEATURES`. `NPC_SIZE` scales them.
  - `routine.ts`: the clock in the header and each person's day: out in the morning, lunch, an afternoon
    stroll or visit, an evening spot, then home for the night. A few night walkers (`NIGHT_WALKER_COUNT` in `map.ts`)
    keep the opposite hours, out from the evening until dawn, so the streets are never empty. The clock follows real time. Set `GAME_SPEED`
    (for example 60) to make a day go by faster in a demo.
  - `crowds.ts`: crowds at live events. From 20 minutes before an event starts until it ends, `CROWD_SIZE`
    people walk in along the paths and gather around its pin. Then they leave. Live events get a pulsing ring
    and a "Happening now" badge, and the header counts them. Events without an end time count as 2 hours.
  - `route-guide.ts`: **Take me there**, a button in each event's popup. It explains why it needs your location,
    then asks the browser for permission. It draws the walking route along real sidewalks from where you are and
    shows the walking time, distance and arrival time. It updates as you move, says when you've arrived, and a
    guide walks the route ahead of you. Your location stays in the browser and isn't sent to the server.
  - `walk-graph.ts`: the walkway network and shortest routes. `NPC_COUNT` in `map.ts` sets how many people there are.
- `http://localhost:3000/add-event.html`: a form to add an event (`src/frontend/add-event.ts`). Event name, date,
  start time and address are required. End time, room, what's free, description and a photo are optional. After you
  enter the address, a pin on a small map shows where it was found, and you can drag it or click to fix the spot.
  The page then says whether the event will show on the map, and links to it. Opened as
  `/add-event.html?edit=<id>` (the popup's **Edit** button), it loads that event and **Save changes** updates it.
  Clearing a field (end time, room, description, free items) or removing the photo clears it on the event.

### Turning editing on and off

Visitors can add, edit and remove events by default. An admin can switch that off for everyone else:

1. At startup the server prints an admin link: `Admin: http://localhost:3000/?admin=<key>`. Open it once. The key
   is saved in that browser and removed from the address bar.
2. An **Admin** bar appears at the bottom of the map and the add-event page. Its **On/Off** button switches visitor
   editing. When it's off, visitors don't see the Edit/Remove buttons or the "Add event" link, and the add-event
   page tells them it's turned off.
3. Admins can always add, edit and remove, whatever the switch says. **Exit admin** (or opening `?admin=off`)
   forgets the key in that browser.

The switch is enforced by the server, not just hidden in the page. When it's off, `POST`, `PATCH` and `DELETE` on
`/api/events` answer `403` unless the request has the admin key in an `X-Admin-Key` header. The setting is saved in
the database, so it survives restarts. The key is generated on first start and saved in the database. To pick your
own key, set `ADMIN_KEY`; the server then doesn't print it. Anyone with the key has full control, so share it only
with people who should moderate events.
- **Hand edits to the pixel-art map** live in `public/map-edits.json`, drawn over the OpenStreetMap data. Positions
  are on the rotated art grid (zoom-19 map pixels turned by `MAP_ROTATION`; one tile is 16):
  `buildings` overrides by OpenStreetMap id (`x`, `y`, `w`, `h`, `look`, or `"removed": true`), `terrain` sets tile
  corners (`"column,row": 0` grass, 1 dirt, 2 sidewalk, 3 water, 4 road) and `fences` puts a fence on a tile
  (`"column,row": 1`, using `public/tiles/fence.png`). It currently holds the fence along Sherbrooke in front of the
  Roddick Gates. The area outline itself is set in `src/frontend/area-data.ts`.
- `http://localhost:3000/api`: a list of the API endpoints.

### Address lookup

`GET /api/geocode?q=<address>` returns `{ latitude, longitude, label }` for an address, or 404 if it can't be found.
The same lookup runs when an event is saved without coordinates. It uses [Photon](https://photon.komoot.io), a
free geocoder built on OpenStreetMap data, and works like this:

- Only places in Montreal are matched (`GEOCODER_BBOX`), so "1 Main St" can't land in another country.
- OpenStreetMap stores Montreal streets under their French names, so English-style addresses are also searched in
  French form: `845 Sherbrooke St W` becomes `845 rue Sherbrooke Ouest`. Building names like `Trottier Building`
  work too.
- If the address has a house number, only buildings with that number count. Matches on the right street come
  first, and among equally good matches **the one nearest McGill wins** (`GEOCODER_CENTER`). If no building has
  that number, the address counts as not found, because a pin somewhere along a long street would be worse than
  no pin.

Lookups run one at a time, at most one per second, and are cached. Call it when a field is finished, not on every
keystroke.

**Suggestions while typing.** The add-event page's address field shows a list of guesses under it as you type. You
can use the arrow keys and Enter, or click one. Picking one fills in the address and drops the pin. The list comes
from `GET /api/geocode/suggest?q=<text>`, which returns
`{ suggestions: [{ label, detail, address, latitude, longitude, kind }], complete }`:

- **McGill buildings first** (`kind: "mcgill"`), from the list in `src/mcgill-buildings.ts`. You can type the
  building's name, the start of it, or a nickname, without the street address: `Trottier`, `trot`, `SSMU`,
  `Shatner`, `Mac Eng`, `RVC`, `New Rez`, `gym`, `law`… Picking one fills in e.g.
  `Trottier Building, 3630 University St`. These need no geocoder, so they show up instantly, and saving an event
  with just a building name (`Trottier`) finds it too. To add a building or a nickname, add a line to
  `MCGILL_BUILDINGS`. The coordinates there come from OpenStreetMap.
- **Then addresses and places** (`kind: "place"`) from Photon, nearest McGill first. Photon isn't asked when the text
  clearly names a McGill building and has no numbers, which keeps requests to the free server down. `complete` is
  `false` if Photon couldn't be reached. The McGill matches are still returned then.

### Walkways

`GET /api/walkways?south=&west=&north=&east=` returns the walkable paths and streets in a box (at most 0.08° a side)
as `{ nodes: [[lat, lng], …], edges: [[i, j], …] }`. The data comes from OpenStreetMap: the Overpass API first,
then the main OpenStreetMap API if Overpass is busy. Each box is cached in `data/walkways/` for 30 days, so it's
fetched once. After you change the area, the first page load takes up to about 30 seconds while it downloads.

`src/frontend/*.ts` compiles to `public/js/`, and `npm run dev` rebuilds it as you edit.

## Locations

Events have `latitude` and `longitude`. If you don't send them, the server looks up the `address` when the event
is created or its address changes (see [Address lookup](#address-lookup): Montreal only, nearest McGill). When an
address can't be found, both coordinates are `null`. At startup the server retries events that have no location.

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

- `date` is `YYYY-MM-DD`. `startTime` and `endTime` are 24-hour `HH:MM`. Only `title`, `date`, `startTime` and
`address` are required. `freeItems` defaults to an empty list.
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
| `GET`    | `/api/settings`                         | `{ publicEditing, admin, canEdit }` for the caller |
| `PUT`    | `/api/settings`                         | Admin only: `{ "publicEditing": true \| false }` |
| `GET`    | `/api/instagram/accounts/:username`     | Links to the account's posts already uploaded (see [Instagram sources](#instagram-sources)) |
| `GET`    | `/api/instagram/accounts`               | Every Instagram account events came from |

When visitor editing is off, the `POST`, `PATCH` and `DELETE` routes above need the admin key in an
`X-Admin-Key` header and otherwise answer `403`.

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

### Instagram sources

Events made by the Instagram scraper (`src/instagram_scrapper/`, parsed by `src/post_parser/`) say where they came
from, so the scraper knows which posts it has already handled.

**When creating an event**, `POST /api/events` takes two optional extra fields:

- `instagramAccount`: the account the event came from. It accepts `mcgillmagicclub`, `@McGillMagicClub` or a profile
  link like `https://www.instagram.com/mcgillmagicclub/`, and is saved as the lowercase username. Empty means none.
  A value that isn't a valid username is rejected with `400`: usernames are 1–30 letters, numbers, `.` and `_`, and
  can't start or end with `.` or have `..`. Post links (`/p/…`, `/reel/…`) are rejected too. This only checks the
  format; it doesn't ask Instagram whether the account exists.
- `instagramPostUrl`: the link to the post the event was made from. Pass the scraper's `permalink`
  (`https://www.instagram.com/p/C1abcDEF/`). `/reel/…` and `/tv/…` links, `instagram.com/<user>/p/…` links and links
  with `?igsh=…` work too. It's saved in canonical form (`https://www.instagram.com/p/C1abcDEF/`). It needs
  `instagramAccount`. Anything that isn't a post link is rejected with `400`.

With both fields, the post is added to the account's **list of uploaded posts**, in the same transaction as the
event. Posts are identified by their shortcode (`C1abcDEF`), which is case-sensitive and the same for `/p/` and
`/reel/` links. Uploading a post that's already on a list answers **`409`**, with the existing event's id in
`details.eventId`, and saves nothing: no event and no photo. This also holds when two uploads of one post arrive at
the same moment. Deleting an event (`DELETE /api/events/:id`) removes its post from the list,
so the scraper may parse that post again on a later pass. Events return both fields (`null` when not from Instagram). They're set
once, when the event is created; `PATCH` ignores them.

**Asking which posts are done:** `GET /api/instagram/accounts/mcgillmagicclub` (or `@name`, or a URL-encoded profile
link) returns the links to that account's uploaded posts, newest upload first:

```json
{ "username": "mcgillmagicclub", "postUrls": ["https://www.instagram.com/p/DXyz_-123/", "https://www.instagram.com/p/C1abcDEF/"] }
```

The list is empty for an account nothing has come from yet, and grows as events are created. An invalid username
gets `400`. `GET /api/instagram/accounts` lists every account with `postCount` and `lastUploadedAt`.

The intended loop, per account: `GET` the list once, fetch the account's recent posts, skip any whose `permalink`
is in the list (a Python `set` makes that instant), parse the rest, and `POST` each one with `instagramAccount` and
`instagramPostUrl`. A `409` just means another run got there first.

```sh
curl http://localhost:3000/api/instagram/accounts/mcgillmagicclub
curl -X POST http://localhost:3000/api/events -H "Content-Type: application/json" \
  -d '{"title":"Free pizza","date":"2026-12-05","startTime":"12:00","address":"Trottier",
       "instagramAccount":"mcgillmagicclub","instagramPostUrl":"https://www.instagram.com/p/C1abcDEF/"}'
```

**Speed.** Lookups use SQLite indexes: posts by shortcode (the primary key) and by account. With 200,000 uploaded
posts across 2,000 accounts, listing an account's 100 URLs takes about 0.1 ms, and checking one post about 0.01 ms.
That's tiny next to fetching, OCR-ing and parsing a post, which takes seconds.

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
