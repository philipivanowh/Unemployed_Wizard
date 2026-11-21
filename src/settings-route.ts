import { Router } from "express";
import { z } from "zod";
import { isAdmin, publicEditingEnabled, requireAdmin, setPublicEditing } from "./settings.ts";

// GET /api/settings        -> { publicEditing, admin, canEdit } for the caller
// PUT /api/settings        -> admin only; body { "publicEditing": true | false }

export const settingsRouter = Router();

function accessFor(admin: boolean) {
  const publicEditing = publicEditingEnabled();
  return { publicEditing, admin, canEdit: publicEditing || admin };
}

settingsRouter.get("/", (req, res) => {
  res.set("Cache-Control", "no-store").json(accessFor(isAdmin(req)));
});

const updateSchema = z.object({ publicEditing: z.boolean() });

settingsRouter.put("/", requireAdmin, (req, res) => {
  const { publicEditing } = updateSchema.parse(req.body ?? {});
  setPublicEditing(publicEditing);
  res.json(accessFor(true));
});
