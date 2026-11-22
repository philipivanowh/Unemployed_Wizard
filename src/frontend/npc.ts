// Pixel-art townspeople in a cozy farming-sim style: a 16×32 sprite seen from a
// top-down 3/4 view, walking in 4 directions, built from 10 physical features
// that each come in several styles and many colors (see NPC_FEATURES).
//
// Each NPC pre-draws its own sprite sheet once (4 directions × 4 walk frames + a
// blink), so drawing it every frame is just one image copy.
// Loaded as a plain <script> before routine.ts and map.ts, so everything here is global.

/**
 * Overall size of every NPC: 1 is full size (one art pixel = one screen pixel, so a
 * person is 32 px tall), 2 is twice as big, 0.5 is half. Whole numbers keep the
 * pixel art perfectly even; in-between sizes drop or double a few art pixels.
 * 0.75 (24 px tall) keeps people small next to the event pins.
 */
const NPC_SIZE = 0.75;

type NpcDirection = "down" | "up" | "left" | "right";

/** Sprite cell, in art pixels. */
const NPC_CELL_W = 16;
const NPC_CELL_H = 32;
/** Where the feet touch the ground inside a cell. */
const NPC_FEET_X = 8;
const NPC_FEET_Y = 31;
/** Sheet rows, in this order. */
const NPC_DIRECTIONS: NpcDirection[] = ["down", "up", "left", "right"];
/** Sheet columns: walk frames 0–3, then the blink frame. */
const NPC_BLINK_FRAME = 4;
const NPC_SHEET_FRAMES = 5;
/** Art pixels walked per animation frame. */
const NPC_STEP_ART_PX = 4;

// ---------------------------------------------------------------------------
// The 10 physical features

/** Every feature, its styles, and the colors it can be. Add colors or styles here. */
const NPC_FEATURES = {
  skin: {
    label: "Skin tone",
    colors: ["#ffe3cf", "#f9d2b4", "#f1c27d", "#e3ad79", "#d39661", "#bf7f4f", "#a1663b", "#86502c", "#6b3d22", "#4f2c19"],
  },
  eyes: {
    label: "Eyes",
    colors: ["#6b3e1f", "#3a2418", "#8e7b3a", "#3f8a4a", "#3d7cc9", "#5aa0d6", "#7a8794", "#c98b2b", "#7f4fb3"],
  },
  hair: {
    label: "Hair",
    styles: ["bald", "buzz", "short", "spiky", "bob", "long", "ponytail", "bun", "curly"],
    colors: [
      "#1f1a1c", "#3b2417", "#5c3a24", "#7a4a2a", "#9c4a2c", "#c0612b", "#d98b4a", "#e2b665",
      "#f1dc9a", "#f4ecd2", "#9a9a9e", "#e6e6e9", "#3a64c8", "#e271a8", "#45a16b", "#7d4fc4", "#d33b4b",
    ],
  },
  facialHair: {
    label: "Facial hair",
    styles: ["none", "stubble", "mustache", "goatee", "beard"],
    /** Usually matches the hair; otherwise one of these. */
    colors: ["#1f1a1c", "#3b2417", "#5c3a24", "#7a4a2a", "#9c4a2c", "#c0612b", "#e2b665", "#9a9a9e", "#e6e6e9"],
  },
  top: {
    label: "Top",
    styles: ["tshirt", "longsleeve", "hoodie", "tank", "jacket", "sweater"],
    colors: [
      "#d64545", "#e8833a", "#e8c547", "#8cc63f", "#3c9a5f", "#2aa3a3", "#4fa3e0", "#3b5fd6",
      "#283a6b", "#8a4fc7", "#e57fb4", "#f2f2f2", "#8c8c8c", "#3d3d3d", "#8b5a3c", "#efe3c2",
    ],
    /** Inner shirt under an open jacket. */
    accents: ["#f2f2f2", "#efe3c2", "#3d3d3d", "#e8c547", "#d64545", "#4fa3e0"],
  },
  bottoms: {
    label: "Bottoms",
    styles: ["pants", "shorts", "skirt"],
    colors: ["#3d5a8a", "#26385a", "#2a2a2e", "#b9a27a", "#6e6e74", "#6b4a32", "#5d6b3a", "#2b3557", "#9c3b3b", "#e6e2da", "#7a5fa6"],
  },
  shoes: {
    label: "Shoes",
    styles: ["sneakers", "boots", "sandals"],
    colors: ["#f2f2f2", "#2a2a2e", "#6b4226", "#c23b3b", "#3b5fd6", "#3c9a5f", "#e8c547", "#8c8c8c", "#e57fb4"],
  },
  hat: {
    label: "Hat",
    styles: ["none", "cap", "beanie", "sunhat"],
    colors: ["#d64545", "#3b5fd6", "#283a6b", "#3c9a5f", "#e8c547", "#2a2a2e", "#f2f2f2", "#e8833a", "#8a4fc7", "#d8c08a"],
  },
  glasses: {
    label: "Glasses",
    styles: ["none", "round", "square", "sunglasses"],
    colors: ["#2a2a2e", "#6b4226", "#c9a227", "#b8bcc4", "#c23b3b", "#3b5fd6", "#e57fb4"],
  },
  bag: {
    label: "Bag",
    styles: ["none", "backpack", "tote"],
    colors: ["#d64545", "#3b5fd6", "#3c9a5f", "#e8c547", "#2a2a2e", "#8b5a3c", "#e8833a", "#8a4fc7", "#2aa3a3", "#d8c08a"],
  },
} as const;

type NpcHairStyle = (typeof NPC_FEATURES)["hair"]["styles"][number];
type NpcFacialHairStyle = (typeof NPC_FEATURES)["facialHair"]["styles"][number];
type NpcTopStyle = (typeof NPC_FEATURES)["top"]["styles"][number];
type NpcBottomsStyle = (typeof NPC_FEATURES)["bottoms"]["styles"][number];
type NpcShoesStyle = (typeof NPC_FEATURES)["shoes"]["styles"][number];
type NpcHatStyle = (typeof NPC_FEATURES)["hat"]["styles"][number];
type NpcGlassesStyle = (typeof NPC_FEATURES)["glasses"]["styles"][number];
type NpcBagStyle = (typeof NPC_FEATURES)["bag"]["styles"][number];

/** One person's look: a pick (style and color) for each of the 10 features. */
interface NpcAppearance {
  skin: string;
  eyes: string;
  hair: { style: NpcHairStyle; color: string };
  facialHair: { style: NpcFacialHairStyle; color: string };
  top: { style: NpcTopStyle; color: string; accent: string };
  bottoms: { style: NpcBottomsStyle; color: string };
  shoes: { style: NpcShoesStyle; color: string };
  hat: { style: NpcHatStyle; color: string };
  glasses: { style: NpcGlassesStyle; color: string };
  bag: { style: NpcBagStyle; color: string };
}

function npcPick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length)]!;
}

/** A random person. Optional extras (facial hair, hats, glasses, bags) show up some of the time. */
function randomNpcAppearance(random: () => number = Math.random): NpcAppearance {
  const F = NPC_FEATURES;
  const withSome = <S extends string>(styles: readonly S[], chance: number): S =>
    random() < chance ? npcPick(styles.filter((s) => s !== "none"), random) : ("none" as S);
  const hairColor = npcPick(F.hair.colors, random);
  return {
    skin: npcPick(F.skin.colors, random),
    eyes: npcPick(F.eyes.colors, random),
    hair: { style: npcPick(F.hair.styles, random), color: hairColor },
    facialHair: {
      style: withSome(F.facialHair.styles, 0.3),
      color: random() < 0.8 ? hairColor : npcPick(F.facialHair.colors, random),
    },
    top: { style: npcPick(F.top.styles, random), color: npcPick(F.top.colors, random), accent: npcPick(F.top.accents, random) },
    bottoms: { style: npcPick(F.bottoms.styles, random), color: npcPick(F.bottoms.colors, random) },
    shoes: { style: npcPick(F.shoes.styles, random), color: npcPick(F.shoes.colors, random) },
    hat: { style: withSome(F.hat.styles, 0.3), color: npcPick(F.hat.colors, random) },
    glasses: { style: withSome(F.glasses.styles, 0.3), color: npcPick(F.glasses.colors, random) },
    bag: { style: withSome(F.bag.styles, 0.45), color: npcPick(F.bag.colors, random) },
  };
}

// ---------------------------------------------------------------------------
// Colors

function npcHexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function npcMix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = npcHexToRgb(a);
  const [r2, g2, b2] = npcHexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

/** Negative darkens toward a warm plum (softer than black), positive lightens. */
function npcShade(color: string, amount: number): string {
  return amount < 0 ? npcMix(color, "#24142a", -amount) : npcMix(color, "#ffffff", amount);
}

// ---------------------------------------------------------------------------
// Drawing one sprite cell

type NpcView = "front" | "back" | "side";

/**
 * Draws a person into a 16×32 cell. Side view faces left (right is mirrored).
 * Walk frames: 0 and 2 are mid-step, 1 and 3 have one foot lifted and the body up a pixel.
 */
function drawNpcCell(ctx: CanvasRenderingContext2D, a: NpcAppearance, view: NpcView, frame: number, blink: boolean): void {
  const step = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const bob = step === 0 ? 0 : -1;
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    if (w <= 0 || h <= 0) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const px = (x: number, y: number, color: string) => rect(x, y, 1, 1, color);

  // Palette for this person.
  const skin = a.skin;
  const skinD = npcShade(skin, -0.18);
  const skinDD = npcShade(skin, -0.4);
  const skinL = npcShade(skin, 0.18);
  const hair = a.hair.color;
  const hairD = npcShade(hair, -0.3);
  const hairL = npcShade(hair, 0.25);
  const top = a.top.color;
  const topD = npcShade(top, -0.25);
  const topL = npcShade(top, 0.2);
  const bot = a.bottoms.color;
  const botD = npcShade(bot, -0.28);
  const shoe = a.shoes.color;
  const shoeD = npcShade(shoe, -0.3);
  const sole = a.shoes.style === "sneakers" ? npcShade(shoe, 0.6) : shoeD;
  const hat = a.hat.color;
  const hatD = npcShade(hat, -0.28);
  const hatL = npcShade(hat, 0.22);
  const bag = a.bag.color;
  const bagD = npcShade(bag, -0.28);
  const bagL = npcShade(bag, 0.2);
  const beard = a.facialHair.color;
  const stubble = npcMix(beard, skin, 0.55);
  const buzz = npcMix(hair, skin, 0.35);
  const frameColor = a.glasses.color;
  const lens = "#1d1b28";
  const lensShine = "#7d88a8";
  const eyeDark = "#1d1418";
  const blush = npcMix(skin, "#ff7a8a", 0.3);

  const y = bob; // head and upper body move with the bob
  const tTop = 16 + bob; // top of the torso
  const longSleeves = a.top.style !== "tshirt" && a.top.style !== "tank";
  const hasHat = a.hat.style !== "none";

  // --- Legs, shoes and waist ---------------------------------------------
  /** Fills a leg column (rows fromRow..toRow) with pants, or bare legs under shorts and skirts. */
  const legColumn = (x: number, w: number, fromRow: number, toRow: number, dark: boolean) => {
    for (let r = fromRow; r <= toRow; r++) {
      const covered = a.bottoms.style === "pants" || (a.bottoms.style === "shorts" && r <= 25);
      rect(x, r, w, 1, covered ? (dark ? botD : bot) : dark ? skinD : skin);
    }
  };

  const shoeFront = (x: number, shoeTop: number) => {
    if (a.shoes.style === "boots") {
      rect(x, shoeTop - 1, 3, 2, shoe);
      rect(x, shoeTop + 1, 3, 1, shoeD);
    } else if (a.shoes.style === "sandals") {
      rect(x, shoeTop, 3, 1, shoe);
      rect(x, shoeTop + 1, 3, 1, skinD);
    } else {
      rect(x, shoeTop, 3, 1, shoe);
      rect(x, shoeTop + 1, 3, 1, sole);
    }
  };

  const legsFrontBack = () => {
    const lift = (side: number) => (step === side ? 1 : 0);
    for (const [x, side] of [
      [5, 1],
      [8, -1],
    ] as const) {
      const shoeTop = 29 - lift(side);
      legColumn(x, 3, 24, shoeTop - 1, false);
      px(x === 5 ? 7 : 8, 24, a.bottoms.style === "pants" ? botD : bot); // seam between the legs
      shoeFront(x, shoeTop);
    }
    if (a.bottoms.style === "skirt") {
      rect(4, 23, 8, 2, bot);
      rect(3, 25, 10, 2, bot);
      rect(3, 26, 10, 1, botD);
    } else {
      rect(4, 23, 8, 1, botD); // waistband
    }
  };

  const legsSide = () => {
    const shoeSide = (x: number, dark: boolean) => {
      const c = dark ? shoeD : shoe;
      if (a.shoes.style === "boots") rect(x + 1, 27, 3, 2, c);
      rect(x, 29, 4, 1, a.shoes.style === "sandals" ? (dark ? skinD : skin) : c);
      rect(x, 30, 4, 1, a.shoes.style === "sandals" ? c : dark ? shoeD : sole);
    };
    if (step === 0) {
      legColumn(6, 3, 24, 28, false);
      shoeSide(5, false);
    } else {
      // Back leg (darker) trails behind, front leg reaches forward (to the left).
      const frontIsNear = step === 1;
      legColumn(7, 3, 24, 26, frontIsNear);
      legColumn(8, 3, 27, 28, frontIsNear);
      shoeSide(8, frontIsNear);
      legColumn(6, 3, 24, 26, !frontIsNear);
      legColumn(5, 3, 27, 28, !frontIsNear);
      shoeSide(3, !frontIsNear);
    }
    if (a.bottoms.style === "skirt") {
      rect(5, 23, 6, 2, bot);
      rect(4, 25, 8, 2, bot);
      rect(4, 26, 8, 1, botD);
    } else {
      rect(5, 23, 6, 1, botD);
    }
  };

  // --- Torso and arms ------------------------------------------------------
  const torsoFrontBack = (back: boolean) => {
    const h = 23 - tTop;
    rect(4, tTop, 8, h, top);
    rect(11, tTop, 1, h, topD);
    rect(5, tTop, 6, 1, topL);
    rect(4, 22, 8, 1, topD);
    const style = a.top.style;
    if (style === "tank") {
      rect(4, tTop, 8, 1, skin);
      px(5, tTop, top);
      px(10, tTop, top);
      if (!back) rect(6, tTop + 1, 4, 1, skin);
    } else if (!back && (style === "tshirt" || style === "longsleeve")) {
      rect(7, tTop, 2, 1, skinD);
    } else if (style === "hoodie") {
      if (back) {
        rect(5, tTop, 6, 3, topD);
        rect(6, tTop + 3, 4, 1, topD);
      } else {
        rect(5, tTop - 1, 6, 1, topD);
        rect(6, tTop + 1, 1, 2, topL);
        rect(9, tTop + 1, 1, 2, topL);
        rect(5, 20, 6, 1, topD);
      }
    } else if (style === "jacket" && !back) {
      rect(7, tTop, 2, h, a.top.accent);
      px(6, tTop, topL);
      px(9, tTop, topL);
    } else if (style === "sweater") {
      if (!back) rect(6, tTop, 4, 1, topD);
      rect(4, 21, 8, 1, topD);
    }
  };

  const armFrontBack = (x: number, swing: number, outerDark: boolean) => {
    const len = 6 + swing;
    rect(x, tTop, 2, len, skin);
    const sleeve = a.top.style === "tank" ? 0 : longSleeves ? len : 3;
    rect(x, tTop, 2, sleeve, top);
    if (longSleeves) rect(x, tTop + len - 1, 2, 1, topD); // cuff
    rect(outerDark ? x : x + 1, tTop, 1, len, sleeve >= len ? topD : skinD);
    if (sleeve > 0 && sleeve < len) rect(outerDark ? x : x + 1, tTop, 1, sleeve, topD);
    rect(x, tTop + len, 2, 2, skin);
    px(outerDark ? x : x + 1, tTop + len + 1, skinD);
  };

  const torsoSide = () => {
    const h = 23 - tTop;
    rect(5, tTop, 6, h, top);
    rect(10, tTop, 1, h, topD);
    rect(5, tTop, 4, 1, topL);
    rect(5, 22, 6, 1, topD);
    if (a.top.style === "hoodie") rect(8, tTop - 1, 3, 2, topD);
    if (a.top.style === "jacket") rect(5, tTop, 1, h, a.top.accent);
    if (a.top.style === "sweater") rect(5, 21, 6, 1, topD);
    if (a.top.style === "tank") {
      rect(5, tTop, 6, 1, skin);
      px(7, tTop, top);
    }
  };

  const armSide = () => {
    const dx = step; // swings opposite the near leg
    const upper = a.top.style === "tank" ? skin : top;
    const lower = longSleeves ? top : skin;
    rect(7, tTop, 2, 3, upper);
    rect(8, tTop, 1, 3, a.top.style === "tank" ? skinD : topD);
    rect(7 + dx, tTop + 3, 2, 3, lower);
    rect(8 + dx, tTop + 3, 1, 3, longSleeves ? topD : skinD);
    rect(7 + dx, tTop + 6, 2, 1, skin);
  };

  // --- Bag -----------------------------------------------------------------
  const bagBehind = () => {
    if (a.bag.style === "backpack" && view === "side") {
      rect(10, tTop + 1, 3, 6, bag);
      rect(12, tTop + 1, 1, 6, bagD);
      rect(10, tTop + 1, 3, 1, bagL);
    }
  };
  const bagOver = () => {
    if (a.bag.style === "none") return;
    if (a.bag.style === "backpack") {
      if (view === "front") {
        rect(5, tTop, 1, 5, bagD);
        rect(10, tTop, 1, 5, bagD);
      } else if (view === "back") {
        rect(4, tTop + 1, 8, 6, bag);
        rect(4, tTop + 1, 8, 2, bagD);
        rect(5, tTop + 4, 6, 2, bagL);
        rect(11, tTop + 3, 1, 4, bagD);
      }
      return;
    }
    // Tote bag on one shoulder.
    if (view === "front") {
      px(11, tTop, bagD);
      px(12, tTop + 1, bagD);
      px(12, tTop + 2, bagD);
      rect(13, tTop + 3, 3, 4, bag);
      rect(13, tTop + 3, 3, 1, bagD);
    } else if (view === "back") {
      px(4, tTop, bagD);
      px(3, tTop + 1, bagD);
      px(3, tTop + 2, bagD);
      rect(0, tTop + 3, 3, 4, bag);
      rect(0, tTop + 3, 3, 1, bagD);
    } else {
      rect(8, tTop, 1, 3, bagD);
      rect(6, tTop + 3, 4, 4, bag);
      rect(6, tTop + 3, 4, 1, bagD);
    }
  };

  // --- Head ----------------------------------------------------------------
  const headShape = () => {
    rect(5, y + 3, 6, 1, skin);
    rect(4, y + 4, 8, 1, skin);
    rect(3, y + 5, 10, 8, skin);
    rect(4, y + 13, 8, 1, skin);
    rect(5, y + 14, 6, 1, skinD);
    rect(12, y + 5, 1, 8, skinD);
    px(11, y + 13, skinD);
  };

  const neck = () => (view === "side" ? rect(7, y + 15, 2, 1, skinD) : rect(6, y + 15, 4, 1, skinD));

  const faceFront = () => {
    px(2, y + 9, skin);
    px(2, y + 10, skinD);
    px(13, y + 9, skin);
    px(13, y + 10, skinD);
    const brow = a.hair.style === "bald" || a.hair.style === "buzz" ? skinDD : hairD;
    px(5, y + 8, brow);
    px(10, y + 8, brow);
    for (const ex of [5, 10]) {
      if (blink) px(ex, y + 10, skinDD);
      else {
        px(ex, y + 9, eyeDark);
        px(ex, y + 10, a.eyes);
      }
    }
    px(4, y + 11, blush);
    px(11, y + 11, blush);
    rect(7, y + 12, 2, 1, skinDD);
  };

  const faceSide = () => {
    px(2, y + 10, skin); // nose
    px(9, y + 9, skin); // ear
    px(9, y + 10, skinD);
    px(10, y + 9, skinD);
    px(4, y + 8, a.hair.style === "bald" || a.hair.style === "buzz" ? skinDD : hairD);
    if (blink) px(4, y + 10, skinDD);
    else {
      px(4, y + 9, eyeDark);
      px(4, y + 10, a.eyes);
    }
    px(5, y + 11, blush);
    px(3, y + 12, skinDD);
  };

  const earsBack = () => {
    px(2, y + 9, skin);
    px(2, y + 10, skinD);
    px(13, y + 9, skin);
    px(13, y + 10, skinD);
  };

  // --- Facial hair -----------------------------------------------------------
  const facialHair = () => {
    const style = a.facialHair.style;
    if (style === "none" || view === "back") return;
    if (view === "front") {
      if (style === "stubble") {
        for (const [sx, sy] of [[4, 12], [6, 13], [9, 13], [11, 12], [5, 13], [10, 13], [7, 14], [8, 14]] as const) px(sx, y + sy, stubble);
      }
      if (style === "mustache" || style === "beard") rect(6, y + 11, 4, 1, beard);
      if (style === "goatee") {
        rect(7, y + 13, 2, 2, beard);
        rect(6, y + 11, 4, 1, beard);
      }
      if (style === "beard") {
        rect(3, y + 10, 1, 3, beard);
        rect(12, y + 10, 1, 3, beard);
        rect(4, y + 12, 3, 2, beard);
        rect(9, y + 12, 3, 2, beard);
        rect(5, y + 14, 6, 1, beard);
        rect(7, y + 13, 2, 1, beard);
      }
    } else {
      if (style === "stubble") {
        for (const [sx, sy] of [[3, 13], [5, 13], [7, 12], [4, 14], [6, 14]] as const) px(sx, y + sy, stubble);
      }
      if (style === "mustache" || style === "beard" || style === "goatee") rect(2, y + 11, 3, 1, beard);
      if (style === "goatee") rect(3, y + 13, 2, 2, beard);
      if (style === "beard") {
        rect(3, y + 12, 6, 2, beard);
        rect(4, y + 14, 4, 1, beard);
        rect(8, y + 9, 1, 3, beard);
      }
    }
  };

  // --- Hair ------------------------------------------------------------------
  const capFrontBack = () => {
    rect(5, y + 2, 6, 1, hair);
    rect(4, y + 3, 8, 1, hair);
    rect(3, y + 4, 10, 3, hair);
    rect(5, y + 3, 3, 1, hairL);
    px(4, y + 4, hairL);
  };
  const capSide = () => {
    rect(6, y + 2, 6, 1, hair);
    rect(4, y + 3, 9, 1, hair);
    rect(3, y + 4, 10, 3, hair);
    rect(5, y + 3, 3, 1, hairL);
  };
  const curlyTop = (back: boolean) => {
    rect(4, y + 0, 8, 1, hair);
    rect(2, y + 1, 12, 1, hair);
    rect(1, y + 2, 14, 5, hair);
    if (back) rect(1, y + 7, 14, 7, hair);
    else if (view === "side") {
      rect(9, y + 7, 5, 6, hair);
      px(2, y + 7, hair);
    } else {
      rect(1, y + 7, 2, 4, hair);
      rect(13, y + 7, 2, 4, hair);
      for (const fx of [4, 6, 9, 11]) px(fx, y + 7, hair);
    }
    for (const [cx, cy] of [[3, 3], [6, 2], [9, 4], [12, 3], [5, 5], [11, 5], [8, 1], [2, 5], [13, 6], [4, 9], [11, 9]] as const) {
      if (back || cy < 7) px(cx, y + cy, hairD);
    }
    px(5, y + 2, hairL);
    px(10, y + 2, hairL);
  };

  const hairFront = () => {
    const s = a.hair.style;
    if (s === "bald") return px(6, y + 4, skinL);
    if (s === "buzz") {
      rect(4, y + 3, 8, 1, buzz);
      rect(3, y + 4, 10, 2, buzz);
      return;
    }
    if (s === "curly") return curlyTop(false);
    capFrontBack();
    if (s === "bob") {
      rect(3, y + 7, 10, 1, hair);
      rect(2, y + 5, 2, 8, hair);
      rect(12, y + 5, 2, 8, hair);
      rect(2, y + 12, 2, 1, hairD);
      rect(12, y + 12, 2, 1, hairD);
    } else if (s === "long") {
      rect(3, y + 7, 3, 1, hair);
      rect(10, y + 7, 3, 1, hair);
      rect(2, y + 5, 2, 15, hair);
      rect(12, y + 5, 2, 15, hair);
      rect(2, y + 19, 2, 1, hairD);
      rect(12, y + 19, 2, 1, hairD);
    } else if (s === "spiky") {
      for (const sx of [4, 7, 10]) px(sx, y + 1, hair);
      px(7, y + 0, hair);
      for (const fx of [3, 5, 7, 9, 11]) px(fx, y + 7, hair);
      px(3, y + 8, hairD);
      px(12, y + 8, hairD);
    } else {
      // short, ponytail and bun share side-swept bangs
      rect(3, y + 7, 6, 1, hair);
      px(8, y + 7, hairD);
      px(3, y + 8, hairD);
      px(12, y + 7, hair);
      px(12, y + 8, hairD);
      if (s === "bun") {
        rect(6, y + 0, 4, 2, hair);
        px(7, y + 0, hairL);
      }
    }
  };

  const hairBack = () => {
    const s = a.hair.style;
    if (s === "bald") return px(7, y + 4, skinL);
    if (s === "buzz") {
      rect(4, y + 3, 8, 1, buzz);
      rect(3, y + 4, 10, 8, buzz);
      return;
    }
    if (s === "curly") return curlyTop(true);
    capFrontBack();
    if (s === "bob") {
      rect(2, y + 5, 12, 9, hair);
      rect(2, y + 13, 12, 1, hairD);
    } else if (s === "long") {
      rect(2, y + 5, 12, 15, hair);
      rect(2, y + 19, 12, 1, hairD);
      for (const lx of [5, 10]) rect(lx, y + 10, 1, 8, hairD);
    } else {
      rect(3, y + 7, 10, 6, hair);
      rect(4, y + 12, 8, 1, hairD);
      if (s === "spiky") {
        for (const sx of [4, 7, 10]) px(sx, y + 1, hair);
        px(7, y + 0, hair);
      }
      if (s === "bun") {
        rect(6, y + 0, 4, 2, hair);
        px(7, y + 0, hairL);
      }
      if (s === "ponytail") {
        rect(7, y + 11, 2, 1, hairD);
        rect(7, y + 12, 2, 6, hair);
        rect(7, y + 17, 2, 1, hairD);
      }
    }
  };

  const hairSide = () => {
    const s = a.hair.style;
    if (s === "bald") return px(7, y + 4, skinL);
    if (s === "buzz") {
      rect(4, y + 3, 8, 1, buzz);
      rect(3, y + 4, 10, 2, buzz);
      rect(10, y + 6, 3, 4, buzz);
      return;
    }
    if (s === "curly") return curlyTop(false);
    capSide();
    rect(3, y + 7, 2, 1, hair); // fringe
    if (s === "bob") {
      rect(9, y + 7, 4, 6, hair);
      rect(9, y + 12, 4, 1, hairD);
    } else if (s === "long") {
      rect(9, y + 7, 4, 13, hair);
      rect(9, y + 19, 4, 1, hairD);
      rect(11, y + 10, 1, 8, hairD);
    } else {
      rect(10, y + 7, 3, 5, hair);
      rect(9, y + 7, 1, 2, hair);
      rect(10, y + 11, 3, 1, hairD);
      if (s === "spiky") {
        for (const sx of [5, 8, 11]) px(sx, y + 1, hair);
        px(8, y + 0, hair);
      }
      if (s === "bun") {
        rect(10, y + 1, 3, 3, hair);
        px(11, y + 1, hairL);
      }
      if (s === "ponytail") {
        px(13, y + 7, hairD);
        rect(13, y + 8, 2, 6, hair);
        rect(13, y + 13, 2, 1, hairD);
      }
    }
  };

  /** Hats hide the top of the hair, so only draw hair below the crown when wearing one. */
  const drawHair = (draw: () => void) => {
    if (!hasHat) return draw();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y + 3, NPC_CELL_W, NPC_CELL_H);
    ctx.clip();
    draw();
    ctx.restore();
  };

  // --- Glasses -------------------------------------------------------------
  const glasses = () => {
    const s = a.glasses.style;
    if (s === "none" || view === "back") return;
    if (view === "front") {
      if (s === "sunglasses") {
        rect(4, y + 9, 3, 2, lens);
        rect(9, y + 9, 3, 2, lens);
        px(4, y + 9, lensShine);
        px(9, y + 9, lensShine);
        rect(7, y + 9, 2, 1, frameColor);
        return;
      }
      for (const gx of [4, 6, 9, 11]) rect(gx, y + 9, 1, 2, frameColor);
      rect(7, y + 9, 2, 1, frameColor);
      if (s === "square") {
        rect(4, y + 8, 3, 1, frameColor);
        rect(9, y + 8, 3, 1, frameColor);
      }
    } else {
      if (s === "sunglasses") rect(3, y + 9, 3, 2, lens);
      else {
        rect(3, y + 9, 1, 2, frameColor);
        rect(5, y + 9, 1, 2, frameColor);
        if (s === "square") rect(3, y + 8, 3, 1, frameColor);
      }
      rect(6, y + 9, 3, 1, frameColor);
    }
  };

  // --- Hat -------------------------------------------------------------------
  const hatOn = () => {
    const s = a.hat.style;
    if (s === "none") return;
    if (s === "sunhat") {
      rect(5, y + 1, 6, 1, hat);
      rect(4, y + 2, 8, 3, hat);
      rect(4, y + 4, 8, 1, hatD);
      rect(0, y + 5, 16, 1, hat);
      rect(1, y + 6, 14, 1, hatD);
      px(5, y + 2, hatL);
      return;
    }
    rect(5, y + 1, 6, 1, hat);
    rect(4, y + 2, view === "side" ? 9 : 8, 1, hat);
    rect(3, y + 3, 10, 3, hat);
    rect(5, y + 2, 3, 1, hatL);
    if (s === "cap") {
      if (view === "front") rect(2, y + 6, 12, 1, hatD);
      else if (view === "side") rect(0, y + 6, 6, 1, hatD);
      else rect(5, y + 5, 6, 1, hatD);
      if (view !== "back") px(view === "side" ? 5 : 7, y + 4, hatL);
    } else {
      // beanie: ribbed fold and a pompom
      rect(3, y + 5, 10, 2, hatD);
      for (let rx = 4; rx <= 12; rx += 2) px(rx, y + 5, hat);
      rect(7, y + 0, 2, 1, hatL);
    }
  };

  // --- Compose the view, back to front ---------------------------------------
  if (view === "side") {
    bagBehind();
    legsSide();
    torsoSide();
    if (a.bag.style === "tote") bagOver();
    armSide();
    neck();
    headShape();
    faceSide();
    facialHair();
    drawHair(hairSide);
    glasses();
    hatOn();
  } else if (view === "front") {
    legsFrontBack();
    torsoFrontBack(false);
    armFrontBack(2, step, true);
    armFrontBack(12, -step, false);
    bagOver();
    neck();
    headShape();
    faceFront();
    facialHair();
    drawHair(hairFront);
    glasses();
    hatOn();
  } else {
    legsFrontBack();
    torsoFrontBack(true);
    armFrontBack(2, -step, true);
    armFrontBack(12, step, false);
    neck();
    headShape();
    earsBack();
    bagOver();
    drawHair(hairBack);
    hatOn();
  }
}

/** Adds a dark outline around everything drawn so far, like hand-made sprites have. */
function npcOutline(ctx: CanvasRenderingContext2D): void {
  const img = ctx.getImageData(0, 0, NPC_CELL_W, NPC_CELL_H);
  const src = img.data;
  const out = new Uint8ClampedArray(src);
  const alpha = (x: number, y: number) =>
    x < 0 || y < 0 || x >= NPC_CELL_W || y >= NPC_CELL_H ? 0 : src[(y * NPC_CELL_W + x) * 4 + 3]!;
  for (let y = 0; y < NPC_CELL_H; y++) {
    for (let x = 0; x < NPC_CELL_W; x++) {
      if (alpha(x, y) > 0) continue;
      if (alpha(x - 1, y) || alpha(x + 1, y) || alpha(x, y - 1) || alpha(x, y + 1)) {
        const i = (y * NPC_CELL_W + x) * 4;
        out[i] = 42;
        out[i + 1] = 26;
        out[i + 2] = 38;
        out[i + 3] = 235;
      }
    }
  }
  ctx.putImageData(new ImageData(out, NPC_CELL_W, NPC_CELL_H), 0, 0);
}

/** Every frame of one person, pre-drawn. Rows follow NPC_DIRECTIONS; columns are frames. */
class NpcSpriteSheet {
  readonly canvas: HTMLCanvasElement;
  readonly appearance: NpcAppearance;

  constructor(appearance: NpcAppearance) {
    this.appearance = appearance;
    const sheet = document.createElement("canvas");
    sheet.width = NPC_SHEET_FRAMES * NPC_CELL_W;
    sheet.height = NPC_DIRECTIONS.length * NPC_CELL_H;
    const sctx = sheet.getContext("2d");
    const cell = document.createElement("canvas");
    cell.width = NPC_CELL_W;
    cell.height = NPC_CELL_H;
    const cctx = cell.getContext("2d", { willReadFrequently: true });
    if (!sctx || !cctx) throw new Error("2D context not supported");

    const views: [number, NpcView][] = [
      [0, "front"],
      [1, "back"],
      [2, "side"],
    ];
    for (const [row, view] of views) {
      for (let frame = 0; frame < NPC_SHEET_FRAMES; frame++) {
        cctx.clearRect(0, 0, NPC_CELL_W, NPC_CELL_H);
        const blink = frame === NPC_BLINK_FRAME;
        drawNpcCell(cctx, appearance, view, blink ? 0 : frame, blink);
        npcOutline(cctx);
        // Soft shadow under the feet, behind everything else.
        cctx.globalCompositeOperation = "destination-over";
        cctx.fillStyle = "rgba(20, 10, 30, 0.25)";
        cctx.fillRect(4, 31, 8, 1);
        cctx.fillRect(3, 30, 10, 1);
        cctx.globalCompositeOperation = "source-over";
        sctx.drawImage(cell, frame * NPC_CELL_W, row * NPC_CELL_H);
      }
    }
    // Facing right is facing left, mirrored.
    for (let frame = 0; frame < NPC_SHEET_FRAMES; frame++) {
      sctx.save();
      sctx.translate(frame * NPC_CELL_W + NPC_CELL_W, 3 * NPC_CELL_H);
      sctx.scale(-1, 1);
      sctx.drawImage(sheet, frame * NPC_CELL_W, 2 * NPC_CELL_H, NPC_CELL_W, NPC_CELL_H, 0, 0, NPC_CELL_W, NPC_CELL_H);
      sctx.restore();
    }
    this.canvas = sheet;
  }
}

// ---------------------------------------------------------------------------
// A walking person

interface NpcPoint {
  x: number;
  y: number;
}

interface NpcOptions {
  appearance?: NpcAppearance;
  x?: number;
  y?: number;
  /** Walking speed in screen pixels per second. */
  speed?: number;
}

class Npc {
  x: number;
  y: number;
  /** Walking speed in screen pixels per second. */
  speed: number;
  /** Screen pixels per art pixel. */
  readonly scale: number;
  /**
   * Screen pixels per unit of x/y. Leave at 1 on a plain canvas. On a zoomable map,
   * where x/y are map coordinates, set it from the zoom so walking looks right.
   */
  worldScale = 1;
  /** How far x/y are rotated on screen, in radians clockwise (for a rotated map). */
  viewRotation = 0;
  direction: NpcDirection = "down";
  /** 0 (invisible) to 1. */
  opacity = 1;
  readonly sheet: NpcSpriteSheet;

  private path: NpcPoint[] = [];
  private resolveWalk: ((arrived: boolean) => void) | null = null;
  /** Screen pixels walked, which drives the step animation. */
  private walked = 0;
  private blinkIn = 1 + Math.random() * 4;
  private blinkLeft = 0;
  private lookAroundIn = 3 + Math.random() * 6;

  constructor(options: NpcOptions = {}) {
    this.sheet = new NpcSpriteSheet(options.appearance ?? randomNpcAppearance());
    this.scale = NPC_SIZE;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.speed = options.speed ?? 26 * NPC_SIZE;
  }

  get appearance(): NpcAppearance {
    return this.sheet.appearance;
  }

  get state(): "idle" | "walking" {
    return this.path.length > 0 ? "walking" : "idle";
  }

  /** The sheet frame showing right now. */
  get frame(): number {
    if (this.state === "walking") return Math.floor(this.walked / (NPC_STEP_ART_PX * this.scale)) % 4;
    return this.blinkLeft > 0 && this.direction !== "up" ? NPC_BLINK_FRAME : 0;
  }

  /** Changes whenever the picture changes, so callers can skip redrawing. */
  get frameKey(): string {
    return `${this.direction}:${this.frame}:${this.opacity.toFixed(2)}`;
  }

  /**
   * Walk through `points` in order. Resolves true on arrival, or false if
   * interrupted by another walk or stop().
   */
  followPath(points: NpcPoint[]): Promise<boolean> {
    this.endWalk(false);
    this.path = points.map((p) => ({ x: p.x, y: p.y }));
    if (this.path.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.resolveWalk = resolve;
    });
  }

  stop(): void {
    this.path = [];
    this.endWalk(false);
  }

  /** Turn to face a direction (while standing). */
  face(direction: NpcDirection): void {
    this.direction = direction;
  }

  update(dt: number): void {
    this.blinkIn -= dt;
    this.blinkLeft = Math.max(0, this.blinkLeft - dt);
    if (this.blinkIn <= 0) {
      this.blinkLeft = 0.14;
      this.blinkIn = 2 + Math.random() * 4;
    }

    if (this.path.length === 0) {
      // Idle people glance around now and then.
      this.lookAroundIn -= dt;
      if (this.lookAroundIn <= 0) {
        this.lookAroundIn = 3 + Math.random() * 7;
        this.direction = npcPick<NpcDirection>(["down", "down", "left", "right", "up"], Math.random);
      }
      return;
    }

    let budget = (this.speed * dt) / this.worldScale; // map units to cover this frame
    let moved = 0;
    while (budget > 0 && this.path.length > 0) {
      const target = this.path[0]!;
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) this.faceToward(dx, dy);
      if (dist <= budget) {
        this.x = target.x;
        this.y = target.y;
        this.path.shift();
        budget -= dist;
        moved += dist;
      } else {
        this.x += (dx / dist) * budget;
        this.y += (dy / dist) * budget;
        moved += budget;
        budget = 0;
      }
    }
    this.walked += moved * this.worldScale;
    if (this.path.length === 0) {
      this.lookAroundIn = 2 + Math.random() * 5;
      this.endWalk(true);
    }
  }

  /** Draws the person with their feet at `at` (screen pixels on ctx). */
  draw(ctx: CanvasRenderingContext2D, at: NpcPoint): void {
    if (this.opacity <= 0) return;
    const s = this.scale;
    const row = NPC_DIRECTIONS.indexOf(this.direction);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(
      this.sheet.canvas,
      this.frame * NPC_CELL_W,
      row * NPC_CELL_H,
      NPC_CELL_W,
      NPC_CELL_H,
      Math.round(at.x - NPC_FEET_X * s),
      Math.round(at.y - NPC_FEET_Y * s),
      NPC_CELL_W * s,
      NPC_CELL_H * s,
    );
    ctx.restore();
  }

  /** Picks the facing from how the step looks on screen (accounting for map rotation). */
  private faceToward(dx: number, dy: number): void {
    const c = Math.cos(this.viewRotation);
    const s = Math.sin(this.viewRotation);
    const sx = dx * c - dy * s;
    const sy = dx * s + dy * c;
    const horizontal = this.direction === "left" || this.direction === "right";
    // A little stickiness stops flickering on diagonal streets.
    const preferHorizontal = horizontal ? Math.abs(sx) >= Math.abs(sy) * 0.8 : Math.abs(sx) > Math.abs(sy) * 1.25;
    this.direction = preferHorizontal ? (sx > 0 ? "right" : "left") : sy > 0 ? "down" : "up";
  }

  private endWalk(arrived: boolean): void {
    const resolve = this.resolveWalk;
    this.resolveWalk = null;
    resolve?.(arrived);
  }
}
