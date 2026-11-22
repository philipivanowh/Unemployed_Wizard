// Edit access, shared by the map and the Add Event page.
//
// The admin "backdoor": open any page once with ?admin=<key> (the server prints a link with
// the key at startup, or use your ADMIN_KEY). This browser then remembers the key and sends
// it with every change. Admins can always add, edit and remove events, and get a small bar
// at the bottom of the page with a switch that turns this on or off for everyone else.
// ?admin=off forgets the key.

interface EditAccess {
  /** Visitors may add, edit and remove events. */
  publicEditing: boolean;
  /** This browser has a valid admin key. */
  admin: boolean;
  /** This browser may add, edit and remove events right now. */
  canEdit: boolean;
}

const ADMIN_KEY_STORAGE = "freeEvents.adminKey";

function storedAdminKey(): string | null {
  try {
    return localStorage.getItem(ADMIN_KEY_STORAGE);
  } catch {
    return null;
  }
}

function forgetAdminKey(): void {
  try {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    // storage blocked: nothing was saved
  }
}

// Take ?admin=<key> out of the address bar (so it isn't bookmarked or shared) and keep it.
(() => {
  const params = new URLSearchParams(location.search);
  const key = params.get("admin");
  if (key === null) return;
  if (key === "" || key === "off") forgetAdminKey();
  else {
    try {
      localStorage.setItem(ADMIN_KEY_STORAGE, key);
    } catch {
      console.warn("Couldn't save the admin key: this browser blocks storage.");
    }
  }
  params.delete("admin");
  const query = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
})();

/** Headers to send with requests that change events. */
function adminHeaders(): Record<string, string> {
  const key = storedAdminKey();
  return key ? { "X-Admin-Key": key } : {};
}

/** What this browser may do. If unknown (server unreachable), assume visitors' defaults. */
async function fetchEditAccess(): Promise<EditAccess> {
  try {
    const res = await fetch("/api/settings", { headers: adminHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const access = (await res.json()) as EditAccess;
    if (!access.admin && storedAdminKey()) {
      console.warn("The saved admin key isn't valid any more; forgetting it.");
      forgetAdminKey();
    }
    return access;
  } catch (err) {
    console.warn("Couldn't check edit access", err);
    return { publicEditing: true, admin: false, canEdit: true };
  }
}

async function savePublicEditing(enabled: boolean): Promise<EditAccess> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ publicEditing: enabled }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as EditAccess;
}

/** For admins: a bar at the bottom of the page to turn visitor editing on or off. */
function mountAdminBar(access: EditAccess, onChange: (access: EditAccess) => void): void {
  if (!access.admin || document.getElementById("admin-bar")) return;

  const style = document.createElement("style");
  style.textContent = `
    #admin-bar { position: fixed; left: 12px; bottom: 12px; z-index: 3000; display: flex; align-items: center;
      gap: 10px; padding: 8px 10px 8px 12px; background: #1a1a1a; color: #f2f2f2; border: 1px solid #000;
      font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
    #admin-bar b { color: #ffffff; }
    #admin-bar button { border: 0; padding: 5px 10px; font: inherit; font-weight: 700; cursor: pointer; }
    #admin-bar .on { background: #1e6b3a; color: #fff; }
    #admin-bar .off { background: #ed1b2f; color: #fff; }
    #admin-bar .leave { background: transparent; color: #b3b3b3; padding: 5px 4px; font-weight: 400; text-decoration: underline; }
    #admin-bar .leave:hover { color: #ffffff; }
  `;
  document.head.append(style);

  const bar = document.createElement("div");
  bar.id = "admin-bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Admin controls");
  const label = document.createElement("span");
  const toggle = document.createElement("button");
  toggle.type = "button";
  const leave = document.createElement("button");
  leave.type = "button";
  leave.className = "leave";
  leave.textContent = "Exit admin";
  leave.title = "Forget the admin key in this browser";

  const render = (a: EditAccess) => {
    label.replaceChildren();
    const tag = document.createElement("b");
    tag.textContent = "Admin";
    label.append(tag, " · Visitors can add, edit and remove events:");
    toggle.textContent = a.publicEditing ? "On" : "Off";
    toggle.className = a.publicEditing ? "on" : "off";
    toggle.setAttribute("aria-pressed", String(a.publicEditing));
    toggle.title = a.publicEditing ? "Click to turn visitor editing off" : "Click to turn visitor editing on";
  };
  render(access);

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      access = await savePublicEditing(!access.publicEditing);
      render(access);
      onChange(access);
    } catch (err) {
      console.error("Couldn't change the setting", err);
      toggle.textContent = "Failed, retry";
    } finally {
      toggle.disabled = false;
    }
  });
  leave.addEventListener("click", () => {
    forgetAdminKey();
    location.reload();
  });

  bar.append(label, toggle, leave);
  document.body.append(bar);
}
