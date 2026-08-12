// The artifact name is the one part of the uv bootstrap that cannot be checked
// on the machine running the tests: a wrong name is a 404 on someone else's
// Windows box and nothing here. Every expected value below was taken from the
// asset list of an actual astral-sh/uv release.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { assetName } from "../../server/uv-bootstrap.mjs";

describe("uv release artifact names", () => {
  it("matches what astral-sh/uv actually publishes", () => {
    expect(assetName("darwin", "arm64")).toBe("uv-aarch64-apple-darwin.tar.gz");
    expect(assetName("darwin", "x64")).toBe("uv-x86_64-apple-darwin.tar.gz");
    expect(assetName("win32", "x64")).toBe("uv-x86_64-pc-windows-msvc.zip");
    expect(assetName("win32", "arm64")).toBe("uv-aarch64-pc-windows-msvc.zip");
    expect(assetName("win32", "ia32")).toBe("uv-i686-pc-windows-msvc.zip");
    expect(assetName("linux", "x64")).toBe("uv-x86_64-unknown-linux-gnu.tar.gz");
    expect(assetName("linux", "arm64")).toBe("uv-aarch64-unknown-linux-gnu.tar.gz");
  });

  it("uses .zip on Windows and .tar.gz elsewhere — the two are unpacked differently", () => {
    expect(assetName("win32", "x64")!.endsWith(".zip")).toBe(true);
    expect(assetName("darwin", "arm64")!.endsWith(".tar.gz")).toBe(true);
    expect(assetName("linux", "x64")!.endsWith(".tar.gz")).toBe(true);
  });

  it("returns null rather than a guess where no build exists", () => {
    expect(assetName("darwin", "ia32")).toBeNull();      // Apple never shipped one
    expect(assetName("linux", "mips" as never)).toBeNull();
    expect(assetName("aix", "x64")).toBeNull();
  });
});
