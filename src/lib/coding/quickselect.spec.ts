import { describe, expect, test } from "vitest";
import { cascadeTops, hitBox, Q_ROW_H, rankDevices, reconcileSlots, type QBox } from "./quickselect";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
const E = "eeeeeeee-0000-4000-8000-000000000005";
const F = "ffffffff-0000-4000-8000-000000000006";

const counts = (...pairs: [string, number][]): Map<string, number> => new Map(pairs);

describe("rankDevices", () => {
  test("ranks by usage count", () => {
    const ranked = rankDevices(counts([A, 1], [B, 4], [C, 2]), [A, C, B]);
    expect(ranked).toEqual([B, C, A]);
  });

  test("ignores devices without entries", () => {
    const ranked = rankDevices(counts([A, 0], [B, 1]), [B]);
    expect(ranked).toEqual([B]);
  });

  test("the code just used outranks a busier one", () => {
    // B has 2 entries, A was coded last: 1 + 3 boost wins the tie against 2 + 2
    const ranked = rankDevices(counts([A, 1], [B, 2]), [B, B, A]);
    expect(ranked).toEqual([A, B]);
  });

  test("the recency boost covers only the last uses", () => {
    // D was coded last (+3), C second last (+2), B third (+1); A is older and
    // gets nothing, so the four equal-count codes rank by recency
    expect(rankDevices(counts([A, 1], [B, 1], [C, 1], [D, 1]), [A, B, C, D])).toEqual([D, C, B, A]);
    // a busy code keeps the lead even against the maximum boost
    expect(rankDevices(counts([A, 4], [B, 1]), [A, A, A, A, B])).toEqual([A, B]);
  });

  test("equal scores rank by most recent use", () => {
    expect(rankDevices(counts([A, 2], [B, 2]), [A, B])).toEqual([B, A]);
    expect(rankDevices(counts([A, 2], [B, 2]), [])).toEqual([A, B]);
  });

  test("is deterministic for identical input", () => {
    const c = counts([A, 1], [B, 1], [C, 1]);
    expect(rankDevices(c, [])).toEqual(rankDevices(c, []));
  });
});

describe("reconcileSlots", () => {
  test("fills the slots in ranking order", () => {
    expect(reconcileSlots([], [], [A, B, C], 3)).toEqual([A, B, C]);
  });

  test("leaves spare slots empty when the document has fewer codes", () => {
    expect(reconcileSlots([], [], [A], 3)).toEqual([A, null, null]);
  });

  test("keeps every slot whose device is still in the top list", () => {
    expect(reconcileSlots([A, B, C], [], [A, B, C], 3)).toEqual([A, B, C]);
  });

  test("ejects only the dropped slot and keeps its neighbours in place", () => {
    // A fell out of the top 3, B and C stay where they are, D takes the free slot
    expect(reconcileSlots([A, B, C], [], [D, B, C], 3)).toEqual([D, B, C]);
  });

  test("refills several ejected slots in ranking order", () => {
    expect(reconcileSlots([A, B, C], [], [C, D, E], 3)).toEqual([D, E, C]);
  });

  test("a pinned slot keeps its tag past the top gate", () => {
    // A is not in the top list at all, but it is pinned in slot 0
    expect(reconcileSlots([A, B], [A, ""], [C, D], 2)).toEqual([A, C]);
  });

  test("a pinned slot is not refilled with a higher-ranked device", () => {
    // A keeps slot 0 pinned, so the two free slots take D and E and B stays put
    expect(reconcileSlots([A, B, C], [A, "", ""], [D, E, B], 3)).toEqual([A, B, D]);
  });

  test("unpinning hands the slot back to the ranking", () => {
    expect(reconcileSlots([A, B], ["", ""], [C, D], 2)).toEqual([C, D]);
  });

  test("shrinks to the configured slot count", () => {
    expect(reconcileSlots([A, B, C, D], ["", "", "", ""], [A, B, C, D], 2)).toEqual([A, B]);
  });

  test("grows and fills the new slots", () => {
    expect(reconcileSlots([A], [""], [A, B], 3)).toEqual([A, B, null]);
  });

  test("drops a slot whose device left the catalog, pinned ones included", () => {
    const known = new Set([B, C]);
    expect(reconcileSlots([A, B], [A, ""], [B, C], 2, known)).toEqual([C, B]);
  });

  test("an empty ranking empties every slot", () => {
    expect(reconcileSlots([A, B], ["", ""], [], 2)).toEqual([null, null]);
  });

  test("a device stored in two slots leaves one free slot", () => {
    // the same id twice in the stored list: the second row is a free one
    expect(reconcileSlots([A, A, ""], ["", "", ""], [A, B], 3)).toEqual([A, B, null]);
  });
});

describe("cascadeTops", () => {
  test("centres the first column on the cursor", () => {
    expect(cascadeTops([4], [])).toEqual([-(4 * Q_ROW_H) / 2]);
    expect(cascadeTops([1], [])).toEqual([-Q_ROW_H / 2]);
  });

  test("centres a deeper column on the item that opened it", () => {
    // col 0: 2 rows from -24; its row 1 is centred at +12. col 1: 3 rows (72 tall)
    // centred there → top -24
    expect(cascadeTops([2, 3], [0, 1])).toEqual([-24, -24]);
    // and the row under the parent, not the row above it
    expect(cascadeTops([2, 1], [0, 0])).toEqual([-24, -24]);
  });
});

describe("hitBox", () => {
  const boxes: QBox[] = [
    { id: "a", kind: "slot", x: 100, y: 100 },
    { id: "b", kind: "node", x: 200, y: 120 },
  ];

  test("finds the tag box a point lands on", () => {
    expect(hitBox(boxes, 120, 110)?.id).toBe("a");
    expect(hitBox(boxes, 210, 130)?.id).toBe("b");
  });

  test("points between and past the rows hit nothing", () => {
    expect(hitBox(boxes, 190, 110)).toBeNull();
    expect(hitBox(boxes, 120, 124)).toBeNull();
    expect(hitBox(boxes, 156, 110)).toBeNull();
  });
});
