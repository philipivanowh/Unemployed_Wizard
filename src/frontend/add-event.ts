// Add Event page (/add-event.html): a form that creates an event through POST /api/events,
// or, opened as /add-event.html?edit=<id>, loads that event and saves changes with PATCH.
// Required: event name, date, start time and address. Everything else is optional.
// Includes a custom time picker, date shortcuts, free-item chips, a photo drop zone,
// a map pin for the exact spot, and a live preview of the event card.
// If editing is turned off for visitors (admin.ts), the form is disabled.
// Wrapped in a function so its names don't clash with the other page scripts.

(() => {
  interface CreatedEvent {
    id: string;
    title: string;
    date: string;
    startTime: string;
    endTime: string | null;
    address: string;
    roomNumber: string | null;
    freeItems: string[];
    description: string;
    thumbnailUrl: string | null;
    latitude: number | null;
    longitude: number | null;
  }

  /** Set when the page edits an existing event (?edit=<id>). */
  const editId = new URLSearchParams(location.search).get("edit");

  const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
  const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const TIME_STEP_MINUTES = 15;

  // -------------------------------------------------------------------------
  // Small helpers

  function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`#${id} is missing from the page`);
    return element as T;
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text; // textContent: user text can't inject HTML
    if (className) element.className = className;
    return element;
  }

  function icon(name: string, size = 18): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.style.width = svg.style.height = `${size}px`;
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function localDateIso(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  /** "17:30" → "5:30 PM" (or "17:30" in 24-hour locales). */
  function formatTime(hhmm: string): string {
    return new Date(2000, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5))).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatDuration(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours} hr${hours === 1 ? "" : "s"}` : `${hours.toFixed(1).replace(/\.0$/, "")} hrs`;
  }

  /** Understands "5:30 pm", "5:30p", "530pm", "17:30", "1730", "5pm", "noon", "midnight". */
  function parseTime(text: string): string | null {
    const s = text.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
    if (!s) return null;
    if (s === "noon") return "12:00";
    if (s === "midnight") return "00:00";
    const m = /^(\d{1,2}):?(\d{2})?(a|am|p|pm)?$/.exec(s);
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? "0");
    const meridiem = m[3];
    if (minute > 59) return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem.startsWith("p") ? 12 : 0);
    } else if (hour > 23) return null;
    return fromMinutes(hour * 60 + minute);
  }

  // -------------------------------------------------------------------------
  // Time picker: a combobox with a list of times and free typing

  interface TimeOption {
    value: string;
    label: string;
    note?: string;
  }

  class TimePicker {
    readonly name: string;
    readonly input: HTMLInputElement;
    private readonly root: HTMLElement;
    private readonly list: HTMLUListElement;
    private readonly clearButton: HTMLButtonElement | null;
    private current = "";
    private shown: TimeOption[] = [];
    private active = -1;
    private filtering = false;
    /** Start time for duration labels (the "Ends" picker). */
    relativeTo: (() => string) | null = null;
    onChange: () => void = () => {};

    constructor(host: HTMLElement, options: { clearable: boolean }) {
      this.name = host.dataset.timePicker ?? "time";
      this.root = el("div", undefined, "time-picker control");
      this.input = el("input", undefined, "input");
      Object.assign(this.input, {
        id: this.name,
        type: "text",
        autocomplete: "off",
        placeholder: host.dataset.placeholder ?? "Select a time",
      });
      this.input.setAttribute("role", "combobox");
      this.input.setAttribute("aria-expanded", "false");
      this.input.setAttribute("aria-autocomplete", "list");
      this.input.setAttribute("aria-controls", `${this.name}-list`);
      this.input.spellcheck = false;
      this.list = el("ul", undefined, "time-list");
      this.list.id = `${this.name}-list`;
      this.list.setAttribute("role", "listbox");
      this.list.hidden = true;
      const chevron = icon("chevron", 16);
      chevron.classList.add("chevron");
      this.root.append(icon("clock"), this.input, chevron, this.list);
      host.replaceWith(this.root);

      this.clearButton = null;
      if (options.clearable) {
        this.clearButton = el("button", "Clear end time", "clear-time");
        this.clearButton.type = "button";
        this.clearButton.hidden = true;
        this.clearButton.addEventListener("click", () => {
          this.setValue("");
          this.input.focus();
        });
        this.root.after(this.clearButton);
      }

      this.input.addEventListener("focus", () => this.open());
      this.input.addEventListener("click", () => this.open());
      this.input.addEventListener("input", () => {
        this.filtering = true;
        this.open();
      });
      this.input.addEventListener("keydown", (e) => this.onKey(e));
      this.input.addEventListener("blur", () => {
        this.commitTyped();
        this.close();
      });
      // Keep focus in the input while picking with the mouse.
      this.list.addEventListener("mousedown", (e) => e.preventDefault());
      this.list.addEventListener("click", (e) => {
        const li = (e.target as HTMLElement).closest<HTMLLIElement>("[data-value]");
        if (li?.dataset.value) {
          this.setValue(li.dataset.value);
          this.close();
        }
      });
    }

    get value(): string {
      return this.current;
    }

    setValue(value: string): void {
      const changed = value !== this.current;
      this.current = value;
      this.input.value = value ? formatTime(value) : "";
      this.input.removeAttribute("aria-invalid");
      if (this.clearButton) this.clearButton.hidden = !value;
      if (changed) this.onChange();
    }

    private allOptions(): TimeOption[] {
      const start = this.relativeTo?.() ?? "";
      const from = start ? toMinutes(start) + TIME_STEP_MINUTES : 0;
      const options: TimeOption[] = [];
      for (let m = from; m < 24 * 60; m += TIME_STEP_MINUTES) {
        const value = fromMinutes(m);
        options.push({
          value,
          label: formatTime(value),
          note: start ? formatDuration(m - toMinutes(start)) : undefined,
        });
      }
      return options;
    }

    private open(): void {
      const typed = this.input.value.trim();
      let options = this.allOptions();
      if (this.filtering && typed) {
        const needle = typed.toLowerCase().replace(/\s+/g, "");
        const matches = options.filter(
          (o) => o.label.toLowerCase().replace(/\s+/g, "").startsWith(needle) || o.value.startsWith(typed),
        );
        const parsed = parseTime(typed);
        const exact = parsed && !matches.some((o) => o.value === parsed) ? [{ value: parsed, label: formatTime(parsed), note: "Use this time" }] : [];
        options = [...exact, ...matches];
      }
      this.shown = options;
      this.render();
      this.list.hidden = false;
      this.root.classList.add("open");
      this.input.setAttribute("aria-expanded", "true");

      // Start on the chosen time, or a sensible one (now for starts, an hour later for ends).
      let index = options.findIndex((o) => o.value === this.current);
      if (index < 0 && !(this.filtering && typed)) {
        const start = this.relativeTo?.();
        const target = start ? toMinutes(start) + 60 : Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / 15) * 15;
        index = options.findIndex((o) => toMinutes(o.value) >= target);
      }
      this.setActive(index < 0 ? (this.filtering ? 0 : -1) : index, "center");
    }

    private close(): void {
      this.list.hidden = true;
      this.root.classList.remove("open");
      this.input.setAttribute("aria-expanded", "false");
      this.input.removeAttribute("aria-activedescendant");
      this.filtering = false;
    }

    private render(): void {
      this.list.replaceChildren();
      if (this.shown.length === 0) {
        this.list.append(el("li", "No matching times. Try “5:30 PM” or “17:30”.", "time-empty"));
        return;
      }
      this.shown.forEach((o, i) => {
        const li = el("li", undefined, "time-option");
        li.id = `${this.name}-opt-${i}`;
        li.dataset.value = o.value;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(o.value === this.current));
        li.append(el("span", o.label));
        if (o.note) li.append(el("span", o.note, "dur"));
        this.list.append(li);
      });
    }

    private setActive(index: number, align: "center" | "nearest" = "nearest"): void {
      this.list.querySelector(".active")?.classList.remove("active");
      this.active = index;
      const li = index >= 0 ? (this.list.children[index] as HTMLElement | undefined) : undefined;
      if (!li || !li.dataset.value) {
        this.input.removeAttribute("aria-activedescendant");
        return;
      }
      li.classList.add("active");
      this.input.setAttribute("aria-activedescendant", li.id);
      if (align === "center") this.list.scrollTop = li.offsetTop - this.list.clientHeight / 2 + li.clientHeight / 2;
      else li.scrollIntoView({ block: "nearest" });
    }

    private onKey(e: KeyboardEvent): void {
      const isOpen = !this.list.hidden;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) return this.open();
        const step = e.key === "ArrowDown" ? 1 : -1;
        this.setActive(Math.max(0, Math.min(this.shown.length - 1, this.active + step)));
      } else if (e.key === "Enter") {
        if (!isOpen) return;
        e.preventDefault(); // don't submit the form while picking
        const option = this.shown[this.active];
        if (option) this.setValue(option.value);
        else this.commitTyped();
        this.close();
      } else if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        this.input.value = this.current ? formatTime(this.current) : "";
        this.close();
      }
    }

    /** Accept whatever was typed, if it's a time; otherwise put the last value back. */
    private commitTyped(): void {
      const typed = this.input.value.trim();
      if (!typed) {
        this.setValue("");
        return;
      }
      const parsed = parseTime(typed);
      if (parsed) this.setValue(parsed);
      else this.input.value = this.current ? formatTime(this.current) : "";
    }
  }

  // -------------------------------------------------------------------------
  // Chip input for "What's free"

  class ChipInput {
    readonly items: string[] = [];
    private readonly box: HTMLElement;
    private readonly input: HTMLInputElement;
    onChange: () => void = () => {};

    constructor(box: HTMLElement, input: HTMLInputElement) {
      this.box = box;
      this.input = input;
      box.addEventListener("click", () => input.focus());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          this.addFrom(input.value);
        } else if (e.key === "Backspace" && !input.value && this.items.length > 0) {
          this.remove(this.items.length - 1);
        }
      });
      input.addEventListener("input", () => {
        if (input.value.includes(",")) this.addFrom(input.value);
        else this.onChange();
      });
      input.addEventListener("blur", () => this.addFrom(input.value));
    }

    /** Items including anything typed but not yet turned into a chip. */
    get all(): string[] {
      const pending = this.input.value.trim();
      return pending ? [...this.items, pending] : [...this.items];
    }

    addFrom(text: string): void {
      for (const raw of text.split(",")) {
        const item = raw.trim().slice(0, 100);
        if (item && this.items.length < 50 && !this.items.some((i) => i.toLowerCase() === item.toLowerCase())) {
          this.items.push(item);
        }
      }
      this.input.value = "";
      this.render();
    }

    remove(index: number): void {
      this.items.splice(index, 1);
      this.render();
      this.input.focus();
    }

    clear(): void {
      this.items.length = 0;
      this.input.value = "";
      this.render();
    }

    private render(): void {
      this.box.querySelectorAll(".chip").forEach((c) => c.remove());
      this.items.forEach((item, i) => {
        const chip = el("span", undefined, "chip");
        chip.append(el("span", item));
        const x = el("button", "×");
        x.type = "button";
        x.setAttribute("aria-label", `Remove ${item}`);
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.remove(i);
        });
        chip.append(x);
        this.box.insertBefore(chip, this.input);
      });
      this.input.placeholder = this.items.length ? "Add another…" : "Type an item and press Enter";
      this.onChange();
    }
  }

  // -------------------------------------------------------------------------
  // Page elements

  const form = byId<HTMLFormElement>("event-form");
  const submitButton = byId<HTMLButtonElement>("submit");
  const resultBox = byId<HTMLDivElement>("result");
  const formError = byId<HTMLDivElement>("form-error");
  const titleInput = byId<HTMLInputElement>("title");
  const dateInput = byId<HTMLInputElement>("date");
  const addressInput = byId<HTMLInputElement>("address");
  const roomInput = byId<HTMLInputElement>("roomNumber");
  const descriptionInput = byId<HTMLTextAreaElement>("description");
  const photoInput = byId<HTMLInputElement>("thumbnail");
  const dropzone = byId<HTMLLabelElement>("dropzone");
  const photoSelected = byId<HTMLDivElement>("photo-selected");
  const photoPreview = byId<HTMLImageElement>("thumbnail-preview");
  const mapStatus = byId<HTMLDivElement>("map-status");
  const pinStatus = byId<HTMLSpanElement>("pin-status");
  const clearPinButton = byId<HTMLButtonElement>("clear-pin");

  const today = localDateIso(new Date());
  dateInput.value = today;
  dateInput.min = today;

  const startPicker = new TimePicker(document.querySelector<HTMLElement>('[data-time-picker="startTime"]')!, { clearable: false });
  const endPicker = new TimePicker(document.querySelector<HTMLElement>('[data-time-picker="endTime"]')!, { clearable: true });
  endPicker.relativeTo = () => startPicker.value;

  const freeItems = new ChipInput(byId("freeItems-box"), byId<HTMLInputElement>("freeItems"));

  // When the start moves, keep the end after it (same length if possible).
  let lastStart = "";
  startPicker.onChange = () => {
    setFieldError("startTime", "");
    const start = startPicker.value;
    if (start && endPicker.value) {
      const duration = lastStart ? toMinutes(endPicker.value) - toMinutes(lastStart) : 60;
      if (toMinutes(endPicker.value) <= toMinutes(start)) {
        const end = toMinutes(start) + (duration > 0 ? duration : 60);
        endPicker.setValue(end < 24 * 60 ? fromMinutes(end) : "");
      }
    }
    lastStart = start;
    updatePreview();
  };
  endPicker.onChange = () => {
    setFieldError("endTime", "");
    updatePreview();
  };
  freeItems.onChange = () => updatePreview();

  // -------------------------------------------------------------------------
  // Errors

  function invalidTarget(name: string): HTMLElement | null {
    if (name === "freeItems") return byId("freeItems-box");
    if (name === "thumbnail") return dropzone;
    return document.getElementById(name);
  }

  function setFieldError(name: string, message: string): void {
    const box = document.getElementById(`${name}-error`);
    if (box) {
      box.replaceChildren();
      if (message) box.append(icon("alert", 14), el("span", message));
    }
    const target = invalidTarget(name);
    if (!target) return;
    if (message) {
      target.setAttribute("aria-invalid", "true");
      if (box) target.setAttribute("aria-describedby", box.id);
    } else {
      target.removeAttribute("aria-invalid");
    }
  }

  function clearErrors(): void {
    form.querySelectorAll<HTMLElement>(".error").forEach((box) => box.replaceChildren());
    document.querySelectorAll("[aria-invalid]").forEach((node) => node.removeAttribute("aria-invalid"));
    formError.hidden = true;
  }

  function showBanner(box: HTMLElement, badge: string, title: string, body: (Node | string)[]): void {
    const badgeEl = el("span", undefined, "badge");
    badgeEl.append(icon(badge, 18));
    const content = el("div", undefined, "content");
    content.append(el("h2", title), ...body);
    box.replaceChildren(badgeEl, content);
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showFormError(message: string): void {
    showBanner(formError, "alert", editId ? "Couldn't save yet" : "Couldn't publish yet", [message]);
  }

  /** Checks in the browser first, so most mistakes show up without a round trip. */
  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!titleInput.value.trim()) errors.title = "Give your event a name.";
    if (!dateInput.value) errors.date = "Pick a date.";
    if (!startPicker.value) errors.startTime = startPicker.input.value.trim() ? "Enter a time like 5:30 PM." : "Pick a start time.";
    if (!addressInput.value.trim()) errors.address = "Enter the address.";
    if (startPicker.value && endPicker.value && endPicker.value <= startPicker.value) errors.endTime = "Must be after the start time.";
    const photo = photoInput.files?.[0];
    if (photo && !PHOTO_TYPES.includes(photo.type)) errors.thumbnail = "Use a JPEG, PNG, WebP or GIF image.";
    else if (photo && photo.size > MAX_PHOTO_BYTES) errors.thumbnail = "The photo must be 10 MB or smaller.";

    for (const [name, message] of Object.entries(errors)) setFieldError(name, message);
    const first = Object.keys(errors)[0];
    if (first) {
      const target = document.getElementById(first);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return !first;
  }

  form.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (target.id) setFieldError(target.id, "");
    updateCounters();
    updatePreview();
  });

  // -------------------------------------------------------------------------
  // Counters and quick dates

  const titleCount = byId("title-count");
  const descriptionCount = byId("description-count");
  function updateCounters(): void {
    titleCount.textContent = `${titleInput.value.length}/120`;
    descriptionCount.textContent = `${descriptionInput.value.length}/5000`;
  }

  function quickDate(kind: string): string {
    const d = new Date();
    if (kind === "tomorrow") d.setDate(d.getDate() + 1);
    if (kind === "saturday") d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
    if (kind === "monday") d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7));
    return localDateIso(d);
  }

  const pills = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-date]"));
  function syncPills(): void {
    for (const pill of pills) pill.setAttribute("aria-pressed", String(quickDate(pill.dataset.date ?? "") === dateInput.value));
  }
  for (const pill of pills) {
    pill.addEventListener("click", () => {
      dateInput.value = quickDate(pill.dataset.date ?? "today");
      setFieldError("date", "");
      syncPills();
      updatePreview();
    });
  }
  dateInput.addEventListener("change", syncPills);

  // -------------------------------------------------------------------------
  // Photo drop zone

  let previewUrl = "";
  /** When editing: the event's current photo, until it's removed or replaced. */
  let existingPhotoUrl = "";
  function showPhoto(): void {
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    const photo = photoInput.files?.[0];
    setFieldError("thumbnail", "");
    if (photo && !PHOTO_TYPES.includes(photo.type)) setFieldError("thumbnail", "Use a JPEG, PNG, WebP or GIF image.");
    else if (photo && photo.size > MAX_PHOTO_BYTES) setFieldError("thumbnail", "The photo must be 10 MB or smaller.");
    else if (photo) previewUrl = URL.createObjectURL(photo);
    else if (existingPhotoUrl) previewUrl = existingPhotoUrl;

    photoPreview.src = previewUrl;
    byId("photo-name").textContent = photo?.name ?? (previewUrl ? "Current photo" : "");
    byId("photo-size").textContent = photo ? `${(photo.size / 1024 / 1024).toFixed(1)} MB` : "";
    photoSelected.hidden = !previewUrl;
    dropzone.hidden = Boolean(previewUrl);
    updatePreview();
  }
  photoInput.addEventListener("change", showPhoto);
  byId("remove-photo").addEventListener("click", () => {
    photoInput.value = "";
    existingPhotoUrl = "";
    showPhoto();
  });
  for (const type of ["dragenter", "dragover"]) {
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.add("over");
    });
  }
  for (const type of ["dragleave", "drop"]) dropzone.addEventListener(type, () => dropzone.classList.remove("over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    photoInput.files = transfer.files;
    showPhoto();
  });

  // -------------------------------------------------------------------------
  // Map pin (the address lookup drops one; dragging or clicking fixes it)

  const pinMap = L.map("pin-map", { zoomSnap: 0.5, scrollWheelZoom: false });
  const areaPoints = DOWNTOWN_AREAS.flatMap((a) => a.ring);
  if (areaPoints.length >= 2) pinMap.fitBounds(L.latLngBounds(areaPoints).pad(0.15));
  else pinMap.setView([45.5048, -73.5772], 14);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(pinMap);
  let pin: L.Marker | null = null;
  /** "lookup" pins came from the address and can be replaced; "manual" pins are the user's. */
  let pinSource: "lookup" | "manual" = "manual";
  let lookupLabel = "";
  let lookedUpAddress = "";
  let pendingLookup: Promise<void> = Promise.resolve();

  function describePin(note = "", busy = false): void {
    if (!pin) {
      mapStatus.dataset.state = busy ? "busy" : note ? "warn" : "idle";
      pinStatus.textContent = note || "Enter the address, or click the map to drop a pin.";
      clearPinButton.hidden = true;
    } else {
      const { lat, lng } = pin.getLatLng();
      const where = pinSource === "lookup" && lookupLabel ? `Found: ${lookupLabel.split(", ").slice(0, 3).join(", ")}.` : `Pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;
      mapStatus.dataset.state = "ok";
      pinStatus.textContent = where + (pinSource === "lookup" ? " Drag the pin if it's off." : " Drag to adjust.");
      clearPinButton.hidden = false;
    }
    updatePreview();
  }

  function setPin(latlng: L.LatLng, source: "lookup" | "manual"): void {
    pinSource = source;
    if (pin) pin.setLatLng(latlng);
    else {
      pin = L.marker(latlng, { draggable: true, title: "Event location", autoPan: true }).addTo(pinMap);
      pin.on("dragend", () => {
        pinSource = "manual";
        describePin();
      });
    }
    describePin();
  }

  function clearPin(): void {
    pin?.remove();
    pin = null;
    pinSource = "manual";
    lookedUpAddress = "";
    describePin();
  }

  pinMap.on("click", (e: L.LeafletMouseEvent) => setPin(e.latlng, "manual"));
  clearPinButton.addEventListener("click", clearPin);

  /** Where the address lands in Montreal (nearest McGill if several match). Runs when the address field is done. */
  async function lookUpAddress(address: string): Promise<void> {
    if (!address || address === lookedUpAddress) return;
    if (pin && pinSource === "manual") return; // never move a pin the user placed
    lookedUpAddress = address;
    describePin("Looking up the address…", true);
    const params = new URLSearchParams({ q: address });
    try {
      const res = await fetch(`/api/geocode?${params}`);
      if (address !== addressInput.value.trim()) return; // the address changed while we waited
      if (!res.ok) {
        if (pin && pinSource === "lookup") clearPin();
        lookedUpAddress = address;
        describePin("Couldn't find that address. Click the map to pin the spot.");
        return;
      }
      const found = (await res.json()) as { latitude: number; longitude: number; label?: string };
      if (pin && pinSource === "manual") return;
      lookupLabel = found.label ?? "";
      const latlng = L.latLng(found.latitude, found.longitude);
      setPin(latlng, "lookup");
      pinMap.setView(latlng, Math.max(pinMap.getZoom(), 16));
    } catch {
      describePin("Couldn't look up the address right now. Click the map to pin the spot.");
    }
  }

  addressInput.addEventListener("change", () => {
    // Picking a suggestion also fires "change"; it has already placed the pin.
    if (suggestionPicked) return;
    pendingLookup = lookUpAddress(addressInput.value.trim());
  });

  // -------------------------------------------------------------------------
  // Address suggestions: a list under the field while typing. McGill buildings come
  // first and can be found by name or nickname ("Trottier", "SSMU", "Mac Eng").

  interface AddressSuggestion {
    label: string;
    detail: string;
    address: string;
    latitude: number;
    longitude: number;
    kind: "mcgill" | "place";
  }

  const SUGGEST_DELAY_MS = 250;
  const suggestList = el("ul", undefined, "suggest-list");
  suggestList.id = "address-suggestions";
  suggestList.setAttribute("role", "listbox");
  suggestList.setAttribute("aria-label", "Address suggestions");
  suggestList.hidden = true;
  addressInput.closest(".control")!.append(suggestList);
  addressInput.setAttribute("role", "combobox");
  addressInput.setAttribute("aria-autocomplete", "list");
  addressInput.setAttribute("aria-controls", suggestList.id);
  addressInput.setAttribute("aria-expanded", "false");
  addressInput.autocomplete = "off"; // the browser's own list would cover ours

  let suggestions: AddressSuggestion[] = [];
  let activeSuggestion = -1;
  let suggestTimer = 0;
  let suggestAbort: AbortController | null = null;
  /** True right after a suggestion is picked, until the field is typed in again. */
  let suggestionPicked = false;

  function closeSuggestions(): void {
    suggestList.hidden = true;
    addressInput.setAttribute("aria-expanded", "false");
    addressInput.removeAttribute("aria-activedescendant");
    activeSuggestion = -1;
  }

  function highlightSuggestion(index: number): void {
    activeSuggestion = index;
    suggestList.querySelectorAll<HTMLElement>(".suggest-option").forEach((li, i) => {
      li.classList.toggle("active", i === index);
      li.setAttribute("aria-selected", String(i === index));
      if (i === index) li.scrollIntoView({ block: "nearest" });
    });
    if (index >= 0) addressInput.setAttribute("aria-activedescendant", `address-suggestion-${index}`);
    else addressInput.removeAttribute("aria-activedescendant");
  }

  function renderSuggestions(note = ""): void {
    suggestList.replaceChildren();
    suggestions.forEach((s, i) => {
      const li = el("li", undefined, "suggest-option");
      li.id = `address-suggestion-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.append(icon(s.kind === "mcgill" ? "door" : "pin", 16));
      const text = el("span", undefined, "suggest-text");
      const main = el("span", s.label, "suggest-label");
      if (s.kind === "mcgill") main.append(el("span", "McGill", "suggest-tag"));
      text.append(main);
      if (s.detail) text.append(el("span", s.detail, "suggest-detail"));
      li.append(text);
      // mousedown, not click: keep focus in the field so the list doesn't close first.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickSuggestion(i);
      });
      li.addEventListener("mousemove", () => {
        if (activeSuggestion !== i) highlightSuggestion(i);
      });
      suggestList.append(li);
    });
    if (note) suggestList.append(el("li", note, "suggest-note"));
    const open = suggestions.length > 0 || Boolean(note);
    suggestList.hidden = !open;
    addressInput.setAttribute("aria-expanded", String(open));
    activeSuggestion = -1;
  }

  async function fetchSuggestions(q: string): Promise<void> {
    suggestAbort?.abort();
    const abort = new AbortController();
    suggestAbort = abort;
    try {
      const res = await fetch(`/api/geocode/suggest?${new URLSearchParams({ q })}`, { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { suggestions: AddressSuggestion[]; complete: boolean };
      if (abort.signal.aborted || q !== addressInput.value.trim() || document.activeElement !== addressInput) return;
      suggestions = body.suggestions;
      renderSuggestions(suggestions.length === 0 && q.length >= 3 ? "No matches yet. Keep typing, or click the map below." : "");
    } catch (err) {
      if ((err as Error).name !== "AbortError") closeSuggestions();
    }
  }

  function pickSuggestion(index: number): void {
    const s = suggestions[index];
    if (!s) return;
    suggestionPicked = true;
    addressInput.value = s.address;
    closeSuggestions();
    setFieldError("address", "");
    // An explicit pick moves the pin, even one placed by hand.
    lookedUpAddress = s.address;
    lookupLabel = [s.label, s.detail.replace(/ · McGill$/, "")].filter(Boolean).join(", ");
    const latlng = L.latLng(s.latitude, s.longitude);
    setPin(latlng, "lookup");
    pinMap.setView(latlng, Math.max(pinMap.getZoom(), 17));
    updatePreview();
  }

  addressInput.addEventListener("input", () => {
    suggestionPicked = false;
    window.clearTimeout(suggestTimer);
    const q = addressInput.value.trim();
    if (q.length < 2) {
      suggestAbort?.abort();
      closeSuggestions();
      return;
    }
    suggestTimer = window.setTimeout(() => void fetchSuggestions(q), SUGGEST_DELAY_MS);
  });

  addressInput.addEventListener("keydown", (e) => {
    const open = !suggestList.hidden && suggestions.length > 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!open) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      highlightSuggestion((activeSuggestion + step + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && open) {
      e.preventDefault(); // pick (the highlighted one, else the top one), don't submit the form
      pickSuggestion(Math.max(0, activeSuggestion));
    } else if (e.key === "Escape" && !suggestList.hidden) {
      e.preventDefault();
      closeSuggestions();
    }
  });

  addressInput.addEventListener("blur", () => {
    window.clearTimeout(suggestTimer);
    closeSuggestions();
  });

  // -------------------------------------------------------------------------
  // Live preview

  const pv = {
    title: byId("pv-title"),
    month: byId("pv-month"),
    day: byId("pv-day"),
    when: byId("pv-when"),
    where: byId("pv-where"),
    items: byId("pv-items"),
    desc: byId("pv-desc"),
    photo: byId<HTMLImageElement>("pv-photo"),
    map: byId("pv-map"),
    mapText: byId("pv-map-text"),
  };

  function updatePreview(): void {
    const title = titleInput.value.trim();
    pv.title.textContent = title || "Your event name";
    pv.title.classList.toggle("placeholder", !title);

    const date = dateInput.value ? new Date(`${dateInput.value}T00:00:00`) : null;
    pv.month.textContent = date ? date.toLocaleDateString(undefined, { month: "short" }).toUpperCase() : "—";
    pv.day.textContent = date ? String(date.getDate()) : "—";
    const day = date ? date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "";
    const time = startPicker.value
      ? `${formatTime(startPicker.value)}${endPicker.value ? ` – ${formatTime(endPicker.value)}` : ""}`
      : "";
    pv.when.textContent = [day, time].filter(Boolean).join(" · ") || "Pick a date and time";

    const address = addressInput.value.trim();
    const room = roomInput.value.trim();
    pv.where.textContent = address ? (room ? `${address} · ${room}` : address) : "Add an address";

    pv.items.replaceChildren(...freeItems.all.map((item) => el("span", item)));
    const desc = descriptionInput.value.trim();
    pv.desc.textContent = desc;
    pv.desc.hidden = !desc;
    pv.photo.src = previewUrl;
    pv.photo.hidden = !previewUrl;

    if (pin) {
      pv.map.dataset.state = "ok";
      pv.mapText.textContent = "Will appear on the map";
    } else {
      pv.map.dataset.state = "idle";
      pv.mapText.textContent = address ? "We'll find the address when you publish" : "Add a location to place it on the map";
    }
  }

  // -------------------------------------------------------------------------
  // Submit

  /** False while editing is turned off for this browser, or the event to edit couldn't load. */
  let formEnabled = true;
  /** When editing: whether the event had a photo when it was loaded. */
  let hadPhoto = false;

  function setBusy(busy: boolean): void {
    submitButton.disabled = busy || !formEnabled;
    submitButton.replaceChildren();
    if (busy) submitButton.append(el("span", undefined, "spinner"), el("span", editId ? "Saving…" : "Publishing…"));
    else submitButton.append(icon("send"), el("span", editId ? "Save changes" : "Publish event"));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!formEnabled) return;
    clearErrors();
    resultBox.hidden = true;
    if (!validate()) return;
    await pendingLookup;
    if (pin && pinSource === "lookup" && lookedUpAddress !== addressInput.value.trim()) clearPin();

    // Creating: leave out empty optional fields. Editing: send them empty, which clears them.
    const data = new FormData();
    const put = (name: string, value: string) => {
      if (value || editId) data.append(name, value);
    };
    data.append("title", titleInput.value.trim());
    data.append("date", dateInput.value);
    data.append("startTime", startPicker.value);
    data.append("address", addressInput.value.trim());
    put("endTime", endPicker.value);
    put("roomNumber", roomInput.value.trim());
    put("freeItems", freeItems.all.join(", "));
    put("description", descriptionInput.value.trim());
    if (pin) {
      const { lat, lng } = pin.getLatLng();
      data.append("latitude", lat.toFixed(6));
      data.append("longitude", lng.toFixed(6));
    }
    const photo = photoInput.files?.[0];
    if (photo) data.append("thumbnail", photo);
    else if (editId && hadPhoto && !existingPhotoUrl) data.append("removeThumbnail", "true");

    setBusy(true);
    try {
      const res = await fetch(editId ? `/api/events/${encodeURIComponent(editId)}` : "/api/events", {
        method: editId ? "PATCH" : "POST",
        headers: adminHeaders(),
        body: data,
      });
      const body = (await res.json().catch(() => ({}))) as CreatedEvent & {
        error?: string;
        details?: { path?: string; message?: string }[];
      };
      if (!res.ok) {
        let placed = false;
        for (const d of Array.isArray(body.details) ? body.details : []) {
          if (d.path && document.getElementById(`${d.path}-error`)) {
            setFieldError(d.path, d.message ?? "Invalid value");
            placed = true;
          }
        }
        if (res.status === 413) {
          setFieldError("thumbnail", "The photo is too large (10 MB max).");
          placed = true;
        }
        showFormError(placed ? "Please fix the highlighted fields." : body.error ?? `Something went wrong (HTTP ${res.status}). Please try again.`);
        if (res.status === 403) void checkAccess();
        return;
      }
      showSuccess(body);
      if (editId) fillForm(body);
      else resetForm();
    } catch {
      showFormError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  });

  function resetForm(): void {
    form.reset();
    dateInput.value = today;
    startPicker.setValue("");
    endPicker.setValue("");
    lastStart = "";
    freeItems.clear();
    photoInput.value = "";
    showPhoto();
    clearPin();
    lookupLabel = "";
    updateCounters();
    syncPills();
    updatePreview();
  }

  // -------------------------------------------------------------------------
  // Result

  function formatWhen(event: CreatedEvent): string {
    const day = new Date(`${event.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    return `${day} · ${formatTime(event.startTime)}${event.endTime ? ` – ${formatTime(event.endTime)}` : ""}`;
  }

  function showSuccess(event: CreatedEvent): void {
    const body: (Node | string)[] = [
      el("div", formatWhen(event)),
      el("div", event.roomNumber ? `${event.address} · ${event.roomNumber}` : event.address),
    ];
    const located = event.latitude !== null && event.longitude !== null;
    if (!located) {
      body.push(el("p", "We couldn't find that address, so it won't show on the map. Click the map above to pin the spot, then save again.", "warn"));
    }
    if (event.date < today) body.push(el("p", "That date has passed, and the map only shows upcoming events.", "warn"));

    const actions = el("div", undefined, "actions");
    if (located && event.date >= today) {
      const view = el("a", "View it on the map →");
      view.href = `/?event=${encodeURIComponent(event.id)}`;
      actions.append(view);
    }
    if (!editId) {
      const another = el("a", "Add another event");
      another.href = "#";
      another.addEventListener("click", (e) => {
        e.preventDefault();
        resultBox.hidden = true;
        titleInput.focus();
      });
      actions.append(another);
    }
    body.push(actions);
    showBanner(resultBox, "check", editId ? `“${event.title}” is updated` : `“${event.title}” is live`, body);
  }

  // -------------------------------------------------------------------------
  // Edit mode and edit access

  /** Puts an existing event into the form. */
  function fillForm(event: CreatedEvent): void {
    titleInput.value = event.title;
    dateInput.value = event.date;
    if (event.date < today) dateInput.min = event.date; // a past event can keep its date
    lastStart = "";
    startPicker.setValue(event.startTime);
    endPicker.setValue(event.endTime ?? "");
    lastStart = event.startTime;
    addressInput.value = event.address;
    roomInput.value = event.roomNumber ?? "";
    descriptionInput.value = event.description;
    freeItems.clear();
    for (const item of event.freeItems) freeItems.addFrom(item.replace(/,/g, " "));

    photoInput.value = "";
    hadPhoto = Boolean(event.thumbnailUrl);
    existingPhotoUrl = event.thumbnailUrl ?? "";
    showPhoto();

    // A pin from the saved location. It counts as an address lookup, so changing the
    // address looks it up again and moves the pin; dragging it makes it yours.
    lookedUpAddress = event.address;
    lookupLabel = "";
    if (event.latitude !== null && event.longitude !== null) {
      const at = L.latLng(event.latitude, event.longitude);
      setPin(at, "lookup");
      pinMap.setView(at, 17);
    } else {
      clearPin();
      lookedUpAddress = event.address;
    }
    updateCounters();
    syncPills();
    updatePreview();
  }

  function setFormEnabled(enabled: boolean): void {
    formEnabled = enabled;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input, button, textarea").forEach((c) => {
      c.disabled = !enabled;
    });
    setBusy(false);
  }

  /** Disables the form (with a message) while this browser isn't allowed to change events. */
  async function checkAccess(): Promise<boolean> {
    const access = await fetchEditAccess();
    mountAdminBar(access, (a) => {
      if (a.canEdit) {
        formError.hidden = true;
        setFormEnabled(true);
      }
    });
    if (!access.canEdit) {
      setFormEnabled(false);
      showBanner(formError, "alert", editId ? "Editing is turned off" : "Adding events is turned off", [
        "Adding, editing and removing events is turned off right now. Please check back later.",
      ]);
    }
    return access.canEdit;
  }

  async function loadEventToEdit(id: string): Promise<void> {
    document.title = "Edit Event";
    const eyebrow = document.querySelector(".page-head .eyebrow");
    if (eyebrow?.lastChild) eyebrow.lastChild.textContent = "Edit event";
    const heading = document.querySelector(".page-head h1");
    if (heading) heading.textContent = "Edit event";
    const intro = document.querySelector(".page-head p");
    if (intro) intro.textContent = "Change anything below, then save. Everyone sees the update on the map.";
    setBusy(false);

    try {
      const res = await fetch(`/api/events/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404) throw new Error("That event doesn't exist any more. It may have been removed.");
      if (!res.ok) throw new Error(`Couldn't load the event (HTTP ${res.status}).`);
      fillForm((await res.json()) as CreatedEvent);
    } catch (err) {
      setFormEnabled(false);
      showBanner(formError, "alert", "Couldn't open this event", [err instanceof Error ? err.message : String(err)]);
    }
  }

  updateCounters();
  syncPills();
  updatePreview();
  void (async () => {
    const allowed = await checkAccess();
    if (editId && allowed) await loadEventToEdit(editId);
  })();
})();
