/**
 * Coordinates.
 *
 * Three different spaces are in play and mixing them up is the single easiest
 * way to put a signature in the wrong corner of a rotated page.
 *
 *  1. Screen space. What the mouse gives you. Origin top left, y grows down,
 *     measured in CSS pixels, already scaled by whatever zoom is applied.
 *
 *  2. View space. The page as the reader sees it, origin top left, y grows
 *     down, measured in PDF points. This is screen space with the zoom
 *     divided out. A page with /Rotate 90 is wider than it is tall here.
 *
 *  3. User space. What actually gets written into the PDF. Origin bottom
 *     left, y grows up, measured in points, and it ignores /Rotate entirely.
 *     Its origin is the corner of the MediaBox, which is not always (0, 0).
 *
 * Everything the user does happens in screen space. Everything pdf-lib draws
 * happens in user space. These functions are the bridge, and they are the
 * reason a stamp lands where you dropped it on a page that has been turned
 * sideways and has an offset MediaBox.
 */

export type Rotation = 0 | 90 | 180 | 270;

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

/** The unrotated page box, straight from pdf-lib's getMediaBox(). */
export type PageBox = {
  /** MediaBox lower-left x. Usually 0, but not always. */
  originX: number;
  /** MediaBox lower-left y. Usually 0, but not always. */
  originY: number;
  /** Unrotated width in points. */
  width: number;
  /** Unrotated height in points. */
  height: number;
  rotation: Rotation;
};

/** Any multiple of 90, positive or negative, folded into 0/90/180/270. */
export function normalizeRotation(degrees: number): Rotation {
  const step = Math.round(degrees / 90) * 90;
  const wrapped = ((step % 360) + 360) % 360;
  return wrapped as Rotation;
}

/** The size the reader sees, which swaps for a quarter turn. */
export function viewSize(box: PageBox): { width: number; height: number } {
  const turned = box.rotation === 90 || box.rotation === 270;
  return turned
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

/**
 * View space to user space.
 *
 * Derivation, for anyone checking this: /Rotate turns the page clockwise when
 * it is displayed, so the unrotated bottom left corner (0, 0) lands at a
 * different display corner for each quarter turn. Track that one corner and
 * the rest follows.
 *
 *   rotate 0    (0,0) shows bottom left    dx = ux,        dy = H - uy
 *   rotate 90   (0,0) shows top left       dx = uy,        dy = ux
 *   rotate 180  (0,0) shows top right      dx = W - ux,    dy = uy
 *   rotate 270  (0,0) shows bottom right   dx = H - uy,    dy = W - ux
 *
 * These are those four, inverted.
 */
export function viewToUser(point: Point, box: PageBox): Point {
  const { width: w, height: h, rotation, originX, originY } = box;
  let ux: number;
  let uy: number;

  switch (rotation) {
    case 90:
      ux = point.y;
      uy = point.x;
      break;
    case 180:
      ux = w - point.x;
      uy = point.y;
      break;
    case 270:
      ux = w - point.y;
      uy = h - point.x;
      break;
    default:
      ux = point.x;
      uy = h - point.y;
  }

  return { x: ux + originX, y: uy + originY };
}

/** User space back to view space. The exact inverse of viewToUser. */
export function userToView(point: Point, box: PageBox): Point {
  const { width: w, height: h, rotation, originX, originY } = box;
  const ux = point.x - originX;
  const uy = point.y - originY;

  switch (rotation) {
    case 90:
      return { x: uy, y: ux };
    case 180:
      return { x: w - ux, y: uy };
    case 270:
      return { x: h - uy, y: w - ux };
    default:
      return { x: ux, y: h - uy };
  }
}

/**
 * A rectangle drawn on screen, converted to the rectangle pdf-lib needs.
 *
 * pdf-lib wants the lower left corner plus a size, in user space. A quarter
 * turn also swaps which side of the rectangle is its width, so this converts
 * both corners and rebuilds the box from whatever came out. Doing it corner by
 * corner means the rotation cases above are the only place the turn is
 * handled.
 */
export function viewRectToUser(rect: Rect, box: PageBox): Rect {
  const a = viewToUser({ x: rect.x, y: rect.y }, box);
  const b = viewToUser({ x: rect.x + rect.width, y: rect.y + rect.height }, box);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Screen to view. Pass the element's own bounding box and the zoom that was
 * used to render it. Works with devicePixelRatio because the canvas is sized
 * in device pixels but laid out in CSS pixels, and this only ever looks at the
 * CSS box.
 */
export function screenToView(
  clientX: number,
  clientY: number,
  elementRect: { left: number; top: number; width: number; height: number },
  view: { width: number; height: number },
): Point {
  const fx = elementRect.width > 0 ? (clientX - elementRect.left) / elementRect.width : 0;
  const fy = elementRect.height > 0 ? (clientY - elementRect.top) / elementRect.height : 0;
  return { x: fx * view.width, y: fy * view.height };
}

/** Keep a point inside the page, so a stamp cannot be dropped off the edge. */
export function clampToView(
  point: Point,
  view: { width: number; height: number },
): Point {
  return {
    x: Math.min(Math.max(point.x, 0), view.width),
    y: Math.min(Math.max(point.y, 0), view.height),
  };
}

/** Normalize a drag into a rectangle regardless of which way it was dragged. */
export function rectFromDrag(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/**
 * Fit a box inside another, keeping its shape. Used for placing images on a
 * page and for sizing thumbnails.
 */
export function fitInside(
  content: { width: number; height: number },
  frame: { width: number; height: number },
): { width: number; height: number; scale: number } {
  if (content.width <= 0 || content.height <= 0) {
    return { width: 0, height: 0, scale: 1 };
  }
  const scale = Math.min(frame.width / content.width, frame.height / content.height);
  return {
    width: content.width * scale,
    height: content.height * scale,
    scale,
  };
}

/** Named page sizes in points, portrait. */
export const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  a3: { width: 841.89, height: 1190.55 },
  a5: { width: 419.53, height: 595.28 },
  tabloid: { width: 792, height: 1224 },
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;
