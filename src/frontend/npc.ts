// Pixel-art character holding a sign.
//
// Loaded as a plain <script> before world.ts, so everything here is global.
// The body, legs, arms and sign are drawn on a small low-res buffer and scaled
// up with smoothing off (pixel art). The head is drawn afterwards at full
// resolution as a clean circle, and can be filled with a picture through
// setHeadImage().
//
// Animation states:
//   "walkingWithSign" - two-bone legs on a gait cycle, body bob, sign bounce
//   "idleWithSign"    - relaxed stance with breathing
// The state follows movement: walkTo() starts walking and arrival goes idle.

type NpcAnimationState = "idleWithSign" | "walkingWithSign";

interface NpcOptions {
  /** Where the feet are, in canvas pixels. */
  x: number;
  y: number;
  /** Walking speed in canvas pixels per second. */
  speed?: number;
  /** Canvas pixels per art pixel. */
  pixelSize?: number;
  /** Head circle radius in canvas pixels. */
  headRadius?: number;
  signText?: string;
  /** Picture drawn inside the head circle. */
  headImage?: string | HTMLImageElement;
  facing?: 1 | -1;
}

const NPC_DEG = Math.PI / 180;

// Body measurements in art pixels.
const NPC_THIGH = 7;
const NPC_SHIN = 7;
const NPC_TORSO = 13;
const NPC_NECK = 2;
const NPC_UPPER_ARM = 6;
const NPC_FOREARM = 6;
const NPC_SIGN_LINE_CHARS = 7;

// Low-res drawing buffer, with the feet at (NPC_ORIGIN_X, NPC_ORIGIN_Y).
const NPC_BUFFER_W = 96;
const NPC_BUFFER_H = 120;
const NPC_ORIGIN_X = 48;
const NPC_ORIGIN_Y = 116;

const NPC_COLORS = {
  skin: "#f2c48d",
  skinShade: "#d39a64",
  shirt: "#3b82f6",
  shirtShade: "#1e4fb8",
  pants: "#374151",
  pantsShade: "#1f2733",
  shoe: "#111827",
  shoeShade: "#05070c",
  pole: "#8b5a2b",
  board: "#fdf6e3",
  boardEdge: "#7c4a1e",
  signText: "#dc2626",
  shadow: "rgba(0, 0, 0, 0.22)",
  headOutline: "#1f2937",
};

// 3x5 pixel font. Each glyph is 5 rows of 3 pixels, top to bottom.
const NPC_FONT: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
  E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
  Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111",
  "0": "111101101101111", "1": "010110010010111", "2": "110001010100111", "3": "110001010001110",
  "4": "101101111001001", "5": "111100110001110", "6": "011100111101111", "7": "111001010010010",
  "8": "111101111101111", "9": "111101111001110",
  "!": "010010010000010", "?": "110001010000010", ".": "000000000000010", ",": "000000000010100",
  "-": "000000111000000", ":": "000010000010000", "'": "010010000000000", " ": "000000000000000",
};

interface NpcLegPose {
  /** Thigh angle from straight down, positive = forward. */
  hip: number;
  /** Knee bend, positive = shin folds backward. */
  knee: number;
}

/**
 * Walk cycle for one leg. t in [0, 1):
 *   0.0-0.5 stance: foot on the ground, hip sweeps back at a steady rate so the
 *           planted foot doesn't slide, knee gives a little as weight loads.
 *   0.5-1.0 swing: hip eases forward and the knee folds up to clear the ground.
 */
function npcGaitLeg(t: number): NpcLegPose {
  const p = ((t % 1) + 1) % 1;
  if (p < 0.5) {
    const s = p / 0.5;
    return {
      hip: (25 - 50 * s) * NPC_DEG,
      knee: (4 + 10 * Math.sin(Math.PI * s)) * NPC_DEG,
    };
  }
  const s = (p - 0.5) / 0.5;
  return {
    hip: -25 * Math.cos(Math.PI * s) * NPC_DEG,
    knee: (4 + 56 * Math.sin(Math.PI * s)) * NPC_DEG,
  };
}

function npcLegHeight(pose: NpcLegPose): number {
  return NPC_THIGH * Math.cos(pose.hip) + NPC_SHIN * Math.cos(pose.hip - pose.knee);
}

function npcLegReach(pose: NpcLegPose): number {
  return NPC_THIGH * Math.sin(pose.hip) + NPC_SHIN * Math.sin(pose.hip - pose.knee);
}

/** Distance the body travels per full walk cycle (two steps), in art pixels. */
const NPC_STRIDE = 2 * (npcLegReach(npcGaitLeg(0)) - npcLegReach(npcGaitLeg(0.5)));

function npcLerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

class Npc {
  x: number;
  y: number;
  /** Walking speed in screen pixels per second. */
  speed: number;
  facing: 1 | -1;
  /**
   * Screen pixels per unit of x/y. Leave at 1 on a plain canvas. On a zoomable
   * map, where x/y are map coordinates, set it from the zoom so the walk speed
   * and leg cycle stay right on screen.
   */
  worldScale = 1;
  readonly pixelSize: number;
  headRadius: number;

  private signLines: string[] = [];
  private headImage: HTMLImageElement | null = null;
  private target: { x: number; y: number } | null = null;
  private resolveWalk: ((arrived: boolean) => void) | null = null;
  /** Walk cycle position, 0..1. */
  private phase = 0;
  /** 0 = idle pose, 1 = walking pose. Eases between them. */
  private walkBlend = 0;
  private time = 0;

  private readonly buffer: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D;

  constructor(options: NpcOptions) {
    this.x = options.x;
    this.y = options.y;
    this.speed = options.speed ?? 90;
    this.pixelSize = options.pixelSize ?? 4;
    this.headRadius = options.headRadius ?? 28;
    this.facing = options.facing ?? 1;
    this.setSignText(options.signText ?? "FREE FOOD");
    if (options.headImage) this.setHeadImage(options.headImage);

    this.buffer = document.createElement("canvas");
    this.buffer.width = NPC_BUFFER_W;
    this.buffer.height = NPC_BUFFER_H;
    const bctx = this.buffer.getContext("2d");
    if (!bctx) throw new Error("2D context not supported");
    this.bctx = bctx;
  }

  get state(): NpcAnimationState {
    return this.target ? "walkingWithSign" : "idleWithSign";
  }

  /**
   * Walk to (x, y) in canvas pixels, where (x, y) is where the feet end up.
   * Resolves true on arrival, or false if interrupted by another walkTo() or stop().
   */
  walkTo(x: number, y: number): Promise<boolean> {
    this.endWalk(false);
    this.target = { x, y };
    return new Promise((resolve) => {
      this.resolveWalk = resolve;
    });
  }

  /** Stop where it is and go idle. */
  stop(): void {
    this.target = null;
    this.endWalk(false);
  }

  setSignText(text: string): void {
    const lines: string[] = [];
    let line = "";
    for (const word of text.toUpperCase().split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= NPC_SIGN_LINE_CHARS) line += " " + word;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line || lines.length === 0) lines.push(line);
    this.signLines = lines;
  }

  /** Fill the head circle with a picture (URL or loaded image). Pass null to clear. */
  setHeadImage(image: string | HTMLImageElement | null): void {
    if (typeof image === "string") {
      const img = new Image();
      img.src = image;
      this.headImage = img;
    } else {
      this.headImage = image;
    }
  }

  update(dt: number): void {
    this.time += dt;

    if (this.target) {
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) this.facing = dx > 0 ? 1 : -1;

      // Ease into full speed while the legs blend into the walk.
      const step = (this.speed * (0.3 + 0.7 * this.walkBlend) * dt) / this.worldScale;
      const moved = Math.min(step, dist);
      if (dist <= step) {
        this.x = this.target.x;
        this.y = this.target.y;
        this.target = null;
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }
      // Advance the cycle by distance travelled so planted feet don't slide.
      this.phase = (this.phase + (moved * this.worldScale) / (NPC_STRIDE * this.pixelSize)) % 1;
      if (!this.target) this.endWalk(true);
    }

    const goal = this.target ? 1 : 0;
    const maxChange = dt * 5;
    this.walkBlend += Math.max(-maxChange, Math.min(maxChange, goal - this.walkBlend));
  }

  /** Draws with the feet at (x, y), or at `at` (screen pixels) when x/y aren't screen coordinates. */
  draw(ctx: CanvasRenderingContext2D, at?: { x: number; y: number }): void {
    const head = this.drawBody();
    const P = this.pixelSize;
    const baseX = Math.round(at?.x ?? this.x);
    const baseY = Math.round(at?.y ?? this.y);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.buffer,
      baseX - NPC_ORIGIN_X * P,
      baseY - NPC_ORIGIN_Y * P,
      NPC_BUFFER_W * P,
      NPC_BUFFER_H * P,
    );
    ctx.restore();

    this.drawHead(ctx, baseX + head.x * P, baseY + head.y * P);
  }

  private endWalk(arrived: boolean): void {
    const resolve = this.resolveWalk;
    this.resolveWalk = null;
    resolve?.(arrived);
  }

  /** Draws everything but the head into the buffer. Returns the head centre in art pixels. */
  private drawBody(): { x: number; y: number } {
    const b = this.bctx;
    const f = this.facing;
    const w = this.walkBlend;
    const C = NPC_COLORS;
    b.clearRect(0, 0, NPC_BUFFER_W, NPC_BUFFER_H);

    const rect = (x: number, y: number, width: number, height: number, color: string) => {
      b.fillStyle = color;
      b.fillRect(NPC_ORIGIN_X + x, NPC_ORIGIN_Y + y, width, height);
    };
    const segment = (x0: number, y0: number, x1: number, y1: number, color: string) => {
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        rect(Math.round(npcLerp(x0, x1, t) - 1), Math.round(npcLerp(y0, y1, t) - 1), 2, 2, color);
      }
    };

    // Legs: blend between the walk cycle and a relaxed idle stance.
    const legPose = (cyclePhase: number, idleHipDeg: number): NpcLegPose => {
      const gait = npcGaitLeg(cyclePhase);
      return {
        hip: npcLerp(idleHipDeg * NPC_DEG, gait.hip, w),
        knee: npcLerp(3 * NPC_DEG, gait.knee, w),
      };
    };
    const nearLeg = legPose(this.phase, 4);
    const farLeg = legPose(this.phase + 0.5, -3);

    // The hip sits as high as the straighter leg allows, which gives the walk its bob.
    const hipY = -2 - Math.round(Math.max(npcLegHeight(nearLeg), npcLegHeight(farLeg)));

    // Idle breathing lifts the chest, arms, sign and head by one pixel.
    const breath = 0.5 - 0.5 * Math.cos((this.time * 2 * Math.PI) / 3.4);
    const chestLift = Math.round(breath * (1 - w));
    // While walking the sign lags the body bob and the arms pump slightly.
    const signDy = Math.round(0.7 * Math.sin(4 * Math.PI * this.phase - 1) * w);
    const handDx = Math.round(0.6 * Math.sin(2 * Math.PI * this.phase) * w);

    const torsoTop = hipY - NPC_TORSO - chestLift;
    const shoulder = { x: 0, y: torsoTop + 2 };
    const handX = f * 6 + handDx;
    const upperHand = { x: handX, y: torsoTop + 4 + signDy };
    const lowerHand = { x: handX, y: torsoTop + 9 + signDy };

    const headR = this.headRadius / this.pixelSize;
    const head = { x: 0, y: torsoTop - NPC_NECK + 1 - headR };

    const drawLeg = (pose: NpcLegPose, pants: string, shoe: string) => {
      const kneeX = f * NPC_THIGH * Math.sin(pose.hip);
      const kneeY = hipY + NPC_THIGH * Math.cos(pose.hip);
      const ankleX = kneeX + f * NPC_SHIN * Math.sin(pose.hip - pose.knee);
      const ankleY = kneeY + NPC_SHIN * Math.cos(pose.hip - pose.knee);
      segment(0, hipY, kneeX, kneeY, pants);
      segment(kneeX, kneeY, ankleX, ankleY, pants);
      const sx = Math.round(ankleX);
      rect(f > 0 ? sx - 1 : sx - 2, Math.round(ankleY), 4, 2, shoe);
    };

    const drawArm = (hand: { x: number; y: number }, sleeve: string, skin: string) => {
      const elbow = this.solveElbow(shoulder, hand);
      segment(shoulder.x, shoulder.y, elbow.x, elbow.y, sleeve);
      segment(elbow.x, elbow.y, hand.x, hand.y, skin);
      rect(Math.round(hand.x) - 1, Math.round(hand.y) - 1, 2, 2, skin);
    };

    // Ground shadow.
    rect(-6, 0, 13, 1, C.shadow);

    // Back to front: far arm, far leg, near leg, torso, sign, near arm.
    drawArm(upperHand, C.shirtShade, C.skinShade);
    drawLeg(farLeg, C.pantsShade, C.shoeShade);
    drawLeg(nearLeg, C.pants, C.shoe);

    rect(-2, torsoTop, 5, hipY - 1 - torsoTop, C.shirt);
    rect(f > 0 ? -2 : 2, torsoTop, 1, hipY - 1 - torsoTop, C.shirtShade);
    rect(-2, hipY - 1, 5, 3, C.pants);
    rect(-1, torsoTop - NPC_NECK, 2, NPC_NECK, C.skinShade);

    const poleX = Math.round(handX);
    const boardBottom = Math.floor(head.y - headR) - 2 + signDy;
    rect(poleX, boardBottom + 1, 1, lowerHand.y + 3 - boardBottom, C.pole);
    this.drawSign(rect, poleX, boardBottom);

    drawArm(lowerHand, C.shirt, C.skin);

    return head;
  }

  private drawSign(
    rect: (x: number, y: number, w: number, h: number, color: string) => void,
    centerX: number,
    bottom: number,
  ): void {
    const C = NPC_COLORS;
    const longest = Math.max(3, ...this.signLines.map((l) => l.length));
    const boardW = longest * 4 - 1 + 4;
    const boardH = this.signLines.length * 6 - 1 + 4;
    const left = centerX - Math.floor(boardW / 2);
    const top = bottom - boardH + 1;

    rect(left, top, boardW, boardH, C.boardEdge);
    rect(left + 1, top + 1, boardW - 2, boardH - 2, C.board);

    this.signLines.forEach((line, row) => {
      const lineW = line.length * 4 - 1;
      const x0 = left + Math.floor((boardW - lineW) / 2);
      const y0 = top + 2 + row * 6;
      [...line].forEach((ch, i) => {
        const glyph = NPC_FONT[ch] ?? NPC_FONT[" "] ?? "";
        for (let p = 0; p < glyph.length; p++) {
          if (glyph[p] === "1") rect(x0 + i * 4 + (p % 3), y0 + Math.floor(p / 3), 1, 1, C.signText);
        }
      });
    });
  }

  /** Two-bone IK: where the elbow goes so the hand reaches `hand`, bending downward. */
  private solveElbow(
    shoulder: { x: number; y: number },
    hand: { x: number; y: number },
  ): { x: number; y: number } {
    const a = NPC_UPPER_ARM;
    const b = NPC_FOREARM;
    const dx = hand.x - shoulder.x;
    const dy = hand.y - shoulder.y;
    const d = Math.min(Math.max(Math.hypot(dx, dy), 0.001), a + b - 0.001);
    const base = Math.atan2(dy, dx);
    const bend = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
    const e1 = { x: shoulder.x + a * Math.cos(base + bend), y: shoulder.y + a * Math.sin(base + bend) };
    const e2 = { x: shoulder.x + a * Math.cos(base - bend), y: shoulder.y + a * Math.sin(base - bend) };
    return e1.y > e2.y ? e1 : e2;
  }

  /** Clean, anti-aliased head circle; shows the head image when one is loaded. */
  private drawHead(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    const r = this.headRadius;
    const img = this.headImage;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      ctx.clip();
      // Cover-fit the picture into the circle.
      const scale = (2 * r) / Math.min(img.naturalWidth, img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = NPC_COLORS.skin;
      ctx.fill();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = NPC_COLORS.headOutline;
    ctx.stroke();
    ctx.restore();
  }
}
