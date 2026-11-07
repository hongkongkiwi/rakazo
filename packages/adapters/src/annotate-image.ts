import type { ImageAnnotationMark } from "@rakazo/contracts";

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 6_000;
const LEGEND_LINE_HEIGHT = 22;
const LEGEND_PADDING = 12;
const LEGEND_MAX_LINES = 10;
const MARK_COLOR = "#e11d48";
const MARK_HALO = "#ffffff";

export class AnnotateImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnotateImageError";
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Marks one image with numbered boxes and a short legend, so a person can point at
 * what they mean before a bot sees it. Coordinates are fractions of the image; the
 * output is a new PNG the caller stores as its own artifact.
 */
export async function annotateImage(input: {
  bytes: Uint8Array;
  marks: readonly ImageAnnotationMark[];
  maxBytes: number;
}): Promise<{
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}> {
  const { default: sharp } = await import("sharp");
  let oriented: { data: Buffer; info: { width: number; height: number } };
  try {
    oriented = await sharp(input.bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AnnotateImageError("This image could not be read");
  }
  const width = oriented.info.width;
  const height = oriented.info.height;
  if (!width || !height) throw new AnnotateImageError("This image could not be read");

  const labels = input.marks
    .map((mark, index) => ({ index: index + 1, label: mark.label?.trim() }))
    .filter((entry): entry is { index: number; label: string } => Boolean(entry.label));
  const legendLines = labels.slice(0, LEGEND_MAX_LINES);
  const legendHeight =
    legendLines.length > 0 ? LEGEND_PADDING * 2 + legendLines.length * LEGEND_LINE_HEIGHT : 0;
  const outHeight = height + legendHeight;
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 320));
  const badgeRadius = Math.max(10, Math.round(Math.min(width, height) / 60));
  const badgeFont = Math.round(badgeRadius * 1.2);

  const boxes = input.marks
    .map((mark, index) => {
      const x = clamp(mark.x, 0, 1) * width;
      const y = clamp(mark.y, 0, 1) * height;
      const boxWidth = Math.min(clamp(mark.width, 0, 1) * width, width - x);
      const boxHeight = Math.min(clamp(mark.height, 0, 1) * height, height - y);
      const badgeX = clamp(x + badgeRadius, badgeRadius, width - badgeRadius);
      const badgeY = clamp(y + badgeRadius, badgeRadius, height - badgeRadius);
      return [
        `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" fill="none" stroke="${MARK_HALO}" stroke-width="${stroke * 2}" />`,
        `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" fill="none" stroke="${MARK_COLOR}" stroke-width="${stroke}" />`,
        `<circle cx="${badgeX}" cy="${badgeY}" r="${badgeRadius}" fill="${MARK_COLOR}" stroke="${MARK_HALO}" stroke-width="${Math.max(1, Math.round(stroke / 2))}" />`,
        `<text x="${badgeX}" y="${badgeY}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${badgeFont}" font-weight="700" fill="${MARK_HALO}">${index + 1}</text>`,
      ].join("");
    })
    .join("");

  // Roughly eight pixels per character at this size; long notes end at the edge.
  const maxLabelChars = Math.max(20, Math.floor((width - LEGEND_PADDING * 2) / 8));
  const legend =
    legendLines.length > 0
      ? [
          `<rect x="0" y="${height}" width="${width}" height="${legendHeight}" fill="${MARK_HALO}" />`,
          ...legendLines.map(
            (entry, index) =>
              `<text x="${LEGEND_PADDING}" y="${height + LEGEND_PADDING + (index + 1) * LEGEND_LINE_HEIGHT - 6}" font-family="sans-serif" font-size="16" fill="#111111">${escapeXml(`${entry.index}. ${entry.label.slice(0, maxLabelChars)}`)}</text>`,
          ),
        ].join("")
      : "";

  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${outHeight}">${boxes}${legend}</svg>`;
  const extended = await sharp(oriented.data)
    .extend({
      bottom: legendHeight,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
  let png: Buffer;
  try {
    png = await sharp(extended)
      .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
      .png()
      .toBuffer();
  } catch {
    throw new AnnotateImageError("This image could not be annotated");
  }
  if (png.byteLength <= input.maxBytes) {
    return {
      bytes: new Uint8Array(png),
      mimeType: "image/png",
      width,
      height: outHeight,
    };
  }
  const jpeg = await sharp(png).jpeg({ quality: 85 }).toBuffer();
  if (jpeg.byteLength > input.maxBytes)
    throw new AnnotateImageError("The annotated image is too large to send");
  return {
    bytes: new Uint8Array(jpeg),
    mimeType: "image/jpeg",
    width,
    height: outHeight,
  };
}
