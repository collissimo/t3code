import { describe, expect, it } from "vite-plus/test";

import { renderScrawlShim } from "./scrawlShim.ts";

describe("renderScrawlShim", () => {
  it("clears run-as-node, which an agent inherits and which has no video decoder", () => {
    const windows = renderScrawlShim({
      platform: "win32",
      executable: "C:\\Program Files (x86)\\T3 100%\\T3 Code.exe",
      t3Home: "C:\\Users\\me\\.t3",
    });
    expect(windows).toContain('set "ELECTRON_RUN_AS_NODE="\r\n');
    expect(windows).toContain('"C:\\Program Files (x86)\\T3 100%%\\T3 Code.exe" --scrawl %*');
    const unix = renderScrawlShim({
      platform: "linux",
      executable: "/opt/it's/t3",
      t3Home: "/home/me/.t3",
    });
    expect(unix).toContain("unset ELECTRON_RUN_AS_NODE\n");
    expect(unix).toContain(`app='/opt/it'"'"'s/t3'`);
    expect(unix).toContain('exec "$app" --scrawl "$@"');
  });
});
