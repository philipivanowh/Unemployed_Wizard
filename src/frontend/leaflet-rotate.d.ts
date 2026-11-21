// Types for the parts of leaflet-rotate (loaded by index.html) that map.ts uses.
import "leaflet";

declare module "leaflet" {
  interface MapOptions {
    /** Enables rotation (and pitch) support. */
    rotate?: boolean;
    /** Initial bearing in degrees, clockwise. */
    bearing?: number;
    rotateControl?: boolean | { closeOnZeroBearing?: boolean };
    shiftKeyRotate?: boolean;
    pitchDrag?: boolean;
    touchRotate?: boolean;
    compassBearing?: boolean;
  }

  interface Map {
    setBearing(degrees: number, options?: { animate?: boolean; duration?: number }): this;
    getBearing(): number;
  }
}
