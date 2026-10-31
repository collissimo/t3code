import { describe, expect, it } from "vite-plus/test";

import { layoutSheet, planSheetRows } from "./contactSheet.ts";

const sizes = (dims: ReadonlyArray<readonly [number, number]>) =>
  dims.map(([width, height]) => ({ width, height }));

describe("planSheetRows", () => {
  it("stacks two frames only when side by side would be too wide", () => {
    expect(planSheetRows([1.6, 1.6])).toEqual([[0, 2]]);
    expect(planSheetRows([2, 2])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("keeps tall crops from being crushed next to wide ones", () => {
    const aspects = [
      [685, 648],
      [1183, 837],
      [1183, 837],
      [694, 726],
      [1183, 1095],
      [694, 1416],
      [898, 1416],
      [898, 1416],
    ].map(([width, height]) => width! / height!);
    const areas = planSheetRows(aspects)
      .flatMap(([start, end]) => {
        const row = aspects.slice(start, end);
        const total = row.reduce((sum, aspect) => sum + aspect, 0);
        return row.map((aspect) => aspect / total ** 2);
      })
      .toSorted((a, b) => a - b);
    const median = (areas[3]! + areas[4]!) / 2;
    expect(areas[0]! / median).toBeGreaterThanOrEqual(0.55);
  });

  it("never gives a narrow frame a row of its own among three or more", () => {
    for (const row of planSheetRows([1.4, 1.4, 1.4])) {
      expect(row[1] - row[0]).toBeGreaterThan(1);
    }
  });

  it("places every frame in order however many marks a capture has", () => {
    const rows = planSheetRows(Array.from({ length: 40 }, () => 1.6));
    expect(
      rows.flatMap(([start, end]) => Array.from({ length: end - start }, (_, i) => start + i)),
    ).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });
});

describe("layoutSheet", () => {
  const within = (dims: ReadonlyArray<readonly [number, number]>) => {
    const layout = layoutSheet(sizes(dims));
    expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(1600);
    expect(layout.width * layout.height).toBeLessThanOrEqual(1_565_000);
    return layout;
  };

  it("fills every row to both sides, with 6 px gutters", () => {
    const layout = within([
      [1054, 327],
      [1183, 837],
      [1183, 837],
      [685, 648],
      [694, 1416],
      [898, 1416],
      [898, 1416],
    ]);
    const tops = [...new Set(layout.cells.map((cell) => cell.y))];
    let bottom = 6;
    for (const y of tops) {
      const cells = layout.cells.filter((cell) => cell.y === y);
      expect(y).toBe(bottom);
      expect(cells[0]!.x).toBe(6);
      const last = cells.at(-1)!;
      expect(last.x + last.width).toBe(layout.width - 6);
      cells.slice(1).forEach((cell, index) => {
        const before = cells[index]!;
        expect(cell.x).toBe(before.x + before.width + 6);
      });
      bottom = y + cells[0]!.height + 6;
    }
    expect(layout.height).toBe(bottom);
  });

  it("keeps each frame's shape", () => {
    const dims = [
      [1200, 600],
      [800, 800],
      [1920, 1080],
      [640, 900],
    ] as const;
    within(dims).cells.forEach((cell, index) => {
      const [width, height] = dims[index]!;
      expect(cell.width / cell.height).toBeCloseTo(width / height, 1);
    });
  });

  it("lays out one to twelve frames of a screen within the caps", () => {
    for (let count = 1; count <= 12; count++) {
      const layout = within(Array.from({ length: count }, () => [2560, 1440] as const));
      expect(layout.cells).toHaveLength(count);
    }
  });

  it("does not blow a small lone frame up past its minimum sheet", () => {
    const layout = within([[320, 200]]);
    expect(layout.width).toBe(640 + 12);
  });
});
