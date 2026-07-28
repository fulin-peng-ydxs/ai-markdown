import { describe, expect, it } from "vitest";

import { desktopPlatform } from "./desktopPlatform";

describe("desktopPlatform", () => {
  it("recognizes supported desktop user agents without treating other agents as macOS", () => {
    expect(
      desktopPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ),
    ).toBe("windows");
    expect(
      desktopPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      ),
    ).toBe("macos");
    expect(desktopPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
  });
});
