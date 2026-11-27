import { describe, expect, it } from "vite-plus/test";

import { formatCreditsUsd, isLowLibraosBalance } from "./libraosCredits.logic";

describe("credits display", () => {
  it("warns below two dollars only when Console enforces the balance", () => {
    expect(isLowLibraosBalance({ enforced: true, availableUsd: 1.99 })).toBe(true);
    expect(isLowLibraosBalance({ enforced: true, availableUsd: 2 })).toBe(false);
    expect(isLowLibraosBalance({ enforced: false, availableUsd: 0 })).toBe(false);
  });

  it("shows whole amounts without cents and keeps cents otherwise", () => {
    expect(formatCreditsUsd(20, "en-US")).toBe("$20");
    expect(formatCreditsUsd(12.34, "en-US")).toBe("$12.34");
  });
});
