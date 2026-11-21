import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { backfillEventCoordinates } from "./events/coordinates.ts";

createApp().listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  void backfillEventCoordinates();
});
