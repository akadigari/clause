import { describe, expect, it } from "vitest";

import {
  clampToView,
  fitInside,
  normalizeRotation,
  rectFromDrag,
  screenToView,
  userToView,
  viewRectToUser,
  viewSize,
  viewToUser,
  type PageBox,
  type Rotation,
} from "./geometry";

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

function box(rotation: Rotation, originX = 0, originY = 0): PageBox {
  return { width: 600, height: 800, rotation, originX, originY };
}

describe("normalizeRotation", () => {
  it("folds any multiple of 90 into the four legal values", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-450)).toBe(270);
  });
});

describe("viewSize", () => {
  it("swaps the sides for a quarter turn and leaves them alone otherwise", () => {
    expect(viewSize(box(0))).toEqual({ width: 600, height: 800 });
    expect(viewSize(box(180))).toEqual({ width: 600, height: 800 });
    expect(viewSize(box(90))).toEqual({ width: 800, height: 600 });
    expect(viewSize(box(270))).toEqual({ width: 800, height: 600 });
  });
});

describe("viewToUser corners", () => {
  // The corner that anchors every case: unrotated user space (0, 0) is the
  // bottom left of the page, and each quarter turn shows it somewhere else.
  it("puts the unrotated bottom left corner where the rotation says", () => {
    const cases: Array<[Rotation, { x: number; y: number }]> = [
      [0, { x: 0, y: 800 }], // bottom left of a 600x800 view
      [90, { x: 0, y: 0 }], // top left of an 800x600 view
      [180, { x: 600, y: 0 }], // top right of a 600x800 view
      [270, { x: 800, y: 600 }], // bottom right of an 800x600 view
    ];
    for (const [rotation, viewPoint] of cases) {
      expect(viewToUser(viewPoint, box(rotation))).toEqual({ x: 0, y: 0 });
    }
  });

  it("maps the four view corners onto the four user corners, once each", () => {
    for (const rotation of ROTATIONS) {
      const page = box(rotation);
      const view = viewSize(page);
      const corners = [
        { x: 0, y: 0 },
        { x: view.width, y: 0 },
        { x: 0, y: view.height },
        { x: view.width, y: view.height },
      ];
      const mapped = corners.map((c) => viewToUser(c, page));
      const asKeys = new Set(mapped.map((p) => `${p.x},${p.y}`));
      expect(asKeys).toEqual(
        new Set(["0,0", "600,0", "0,800", "600,800"]),
      );
    }
  });
});

describe("viewToUser and userToView round trip", () => {
  it("returns the same point for every rotation", () => {
    for (const rotation of ROTATIONS) {
      const page = box(rotation);
      const view = viewSize(page);
      for (const point of [
        { x: 0, y: 0 },
        { x: 13.5, y: 41.25 },
        { x: view.width / 3, y: view.height / 7 },
        { x: view.width, y: view.height },
      ]) {
        const back = userToView(viewToUser(point, page), page);
        expect(back.x).toBeCloseTo(point.x, 10);
        expect(back.y).toBeCloseTo(point.y, 10);
      }
    }
  });

  it("still round trips when the MediaBox does not start at zero", () => {
    for (const rotation of ROTATIONS) {
      const page = box(rotation, 12, -30);
      const view = viewSize(page);
      const point = { x: view.width * 0.42, y: view.height * 0.77 };
      const back = userToView(viewToUser(point, page), page);
      expect(back.x).toBeCloseTo(point.x, 10);
      expect(back.y).toBeCloseTo(point.y, 10);
    }
  });
});

describe("MediaBox origin", () => {
  it("shifts the result by exactly the origin and nothing else", () => {
    const point = { x: 100, y: 200 };
    for (const rotation of ROTATIONS) {
      const plain = viewToUser(point, box(rotation));
      const shifted = viewToUser(point, box(rotation, 25, 40));
      expect(shifted.x - plain.x).toBeCloseTo(25, 10);
      expect(shifted.y - plain.y).toBeCloseTo(40, 10);
    }
  });
});

describe("viewRectToUser", () => {
  it("keeps the area of the rectangle through every rotation", () => {
    const rect = { x: 40, y: 60, width: 120, height: 45 };
    for (const rotation of ROTATIONS) {
      const out = viewRectToUser(rect, box(rotation));
      expect(out.width * out.height).toBeCloseTo(120 * 45, 6);
      expect(out.width).toBeGreaterThan(0);
      expect(out.height).toBeGreaterThan(0);
    }
  });

  it("swaps width and height on a quarter turn", () => {
    const rect = { x: 10, y: 10, width: 100, height: 20 };
    const upright = viewRectToUser(rect, box(0));
    expect(upright.width).toBeCloseTo(100, 6);
    expect(upright.height).toBeCloseTo(20, 6);

    const turned = viewRectToUser(rect, box(90));
    expect(turned.width).toBeCloseTo(20, 6);
    expect(turned.height).toBeCloseTo(100, 6);
  });

  it("lands inside the page for an unrotated page", () => {
    // A box 40pt from the left and 60pt down from the top of a 600x800 page
    // sits 800 - 60 - 45 = 695 points up from the bottom in user space.
    const out = viewRectToUser({ x: 40, y: 60, width: 120, height: 45 }, box(0));
    expect(out).toEqual({ x: 40, y: 695, width: 120, height: 45 });
  });
});

describe("screenToView", () => {
  it("divides out the zoom, so the answer is in points either way", () => {
    const view = { width: 600, height: 800 };
    const at100 = screenToView(150, 200, { left: 0, top: 0, width: 600, height: 800 }, view);
    const at200 = screenToView(300, 400, { left: 0, top: 0, width: 1200, height: 1600 }, view);
    expect(at100).toEqual(at200);
    expect(at100).toEqual({ x: 150, y: 200 });
  });

  it("subtracts the element offset on the page", () => {
    const view = { width: 600, height: 800 };
    const point = screenToView(
      280,
      340,
      { left: 100, top: 40, width: 600, height: 800 },
      view,
    );
    expect(point).toEqual({ x: 180, y: 300 });
  });

  it("does not divide by zero on an unlaid-out element", () => {
    const point = screenToView(10, 10, { left: 0, top: 0, width: 0, height: 0 }, {
      width: 600,
      height: 800,
    });
    expect(point).toEqual({ x: 0, y: 0 });
  });
});

describe("clampToView", () => {
  it("holds a point inside the page", () => {
    const view = { width: 600, height: 800 };
    expect(clampToView({ x: -12, y: 900 }, view)).toEqual({ x: 0, y: 800 });
    expect(clampToView({ x: 300, y: 400 }, view)).toEqual({ x: 300, y: 400 });
  });
});

describe("rectFromDrag", () => {
  it("normalizes a drag made in any direction", () => {
    const forward = rectFromDrag({ x: 10, y: 10 }, { x: 60, y: 40 });
    const backward = rectFromDrag({ x: 60, y: 40 }, { x: 10, y: 10 });
    expect(forward).toEqual({ x: 10, y: 10, width: 50, height: 30 });
    expect(backward).toEqual(forward);
  });
});

describe("fitInside", () => {
  it("keeps the shape and picks the limiting side", () => {
    const wide = fitInside({ width: 200, height: 100 }, { width: 100, height: 100 });
    expect(wide).toEqual({ width: 100, height: 50, scale: 0.5 });

    const tall = fitInside({ width: 100, height: 200 }, { width: 100, height: 100 });
    expect(tall).toEqual({ width: 50, height: 100, scale: 0.5 });
  });

  it("does not blow up on an empty image", () => {
    expect(fitInside({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({
      width: 0,
      height: 0,
      scale: 1,
    });
  });
});
