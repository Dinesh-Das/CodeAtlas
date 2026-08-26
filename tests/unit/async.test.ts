import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/core/async.js";

describe("bounded async mapping", () => {
  it("preserves input order while limiting active work", async () => {
    let active = 0;
    let maximumActive = 0;
    const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });

    expect(values).toEqual([2, 4, 6, 8, 10]);
    expect(maximumActive).toBe(2);
  });
});
