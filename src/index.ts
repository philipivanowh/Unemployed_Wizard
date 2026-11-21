import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { backfillEventCoordinates } from "./events/coordinates.ts";
import { adminKey, adminKeySource, publicEditingEnabled } from "./settings.ts";

createApp().listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  console.log(`Visitors can ${publicEditingEnabled() ? "" : "NOT "}add, edit and remove events.`);
  if (adminKeySource === "env") {
    console.log("Admin: open any page with ?admin=<your ADMIN_KEY> to unlock the admin controls.");
  } else {
    console.log(`Admin: http://localhost:${config.port}/?admin=${encodeURIComponent(adminKey)}`);
  }
  void backfillEventCoordinates();
});
