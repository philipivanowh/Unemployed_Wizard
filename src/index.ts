import { createApp } from "./app.js";
import { config } from "./config.js";
import { backfillEventCoordinates } from "./events/coordinates.js";

createApp().listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  void backfillEventCoordinates();
});
