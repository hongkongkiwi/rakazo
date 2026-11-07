import { describe, expect, it } from "vitest";
import { AnnotateImageError, annotateImage } from "./annotate-image.js";

async function whitePng(width: number, height: number): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer(),
  );
}

describe("annotateImage", () => {
  it("adds a legend below the image and keeps the boxes inside it", async () => {
    const { default: sharp } = await import("sharp");
    const result = await annotateImage({
      bytes: await whitePng(200, 100),
      marks: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, label: "Total is wrong" }],
      maxBytes: 10 * 1024 * 1024,
    });
    expect(result.mimeType).toBe("image/png");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(200);
    // 12px padding, one 22px line, 12px padding.
    expect(meta.height).toBe(146);
  });

  it("keeps the image height when no mark has a label", async () => {
    const { default: sharp } = await import("sharp");
    const result = await annotateImage({
      bytes: await whitePng(120, 80),
      marks: [{ x: 0, y: 0, width: 1, height: 1 }],
      maxBytes: 10 * 1024 * 1024,
    });
    expect(await sharp(result.bytes).metadata()).toMatchObject({ width: 120, height: 80 });
  });

  it("refuses bytes that are not an image", async () => {
    await expect(
      annotateImage({
        bytes: new Uint8Array([1, 2, 3]),
        marks: [{ x: 0, y: 0, width: 1, height: 1 }],
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(AnnotateImageError);
  });

  it("refuses an annotated image larger than the send limit", async () => {
    await expect(
      annotateImage({
        bytes: await whitePng(400, 400),
        marks: [{ x: 0, y: 0, width: 1, height: 1 }],
        maxBytes: 10,
      }),
    ).rejects.toThrow("too large");
  });
});
