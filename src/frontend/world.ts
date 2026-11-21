// World: sets up the canvas, runs the animation loop, and drives the NPC.
// Npc comes from npc.ts, which index.html loads first.

function getWorldCanvas(): HTMLCanvasElement {
  const el = document.getElementById("myCanvas");
  if (!(el instanceof HTMLCanvasElement)) throw new Error("Canvas element not found");
  return el;
}

function getWorldContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D context not supported");
  return context;
}

const worldCanvas = getWorldCanvas();
const worldCtx = getWorldContext(worldCanvas);
const HORIZON_Y = 230;

const npc = new Npc({ x: 120, y: 360, signText: "FREE FOOD" });

// To put a picture in the head circle later:
// npc.setHeadImage("/uploads/your-picture.jpg");

function drawWorld(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#bfdbfe";
  ctx.fillRect(0, 0, worldCanvas.width, HORIZON_Y);
  ctx.fillStyle = "#86c06c";
  ctx.fillRect(0, HORIZON_Y, worldCanvas.width, worldCanvas.height - HORIZON_Y);

  ctx.fillStyle = "#1f2937";
  ctx.font = "14px monospace";
  ctx.fillText(`Click to walk there  ·  state: ${npc.state}`, 12, 22);
}

// Click anywhere on the ground to send the NPC there.
worldCanvas.addEventListener("click", (event) => {
  const box = worldCanvas.getBoundingClientRect();
  const x = ((event.clientX - box.left) * worldCanvas.width) / box.width;
  const y = ((event.clientY - box.top) * worldCanvas.height) / box.height;
  void npc.walkTo(x, Math.max(y, HORIZON_Y + 20));
});

let lastFrame = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  npc.update(dt);
  drawWorld(worldCtx);
  npc.draw(worldCtx);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Demo: walk across, then stand idle holding the sign.
void npc.walkTo(560, 360).then((arrived) => {
  console.log(arrived ? "NPC arrived" : "NPC walk was interrupted");
});
