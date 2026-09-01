export function pixelsToPercent(pixels: number, containerSize: number): number {
  if (!Number.isFinite(pixels) || !Number.isFinite(containerSize) || containerSize <= 0) {
    return 0;
  }
  return (pixels / containerSize) * 100;
}

export function percentToPixels(percent: number, containerSize: number): number {
  if (!Number.isFinite(percent) || !Number.isFinite(containerSize) || containerSize <= 0) {
    return 0;
  }
  return Math.round((percent / 100) * containerSize);
}

export function paneBoundsPercent(
  containerSize: number,
  minPixels: number,
  maxPixels: number,
): { min: number; max: number } {
  if (containerSize <= 0) return { min: 0, max: 100 };
  const min = Math.min(100, Math.max(0, pixelsToPercent(minPixels, containerSize)));
  const max = Math.min(100, Math.max(min, pixelsToPercent(maxPixels, containerSize)));
  return { min, max };
}
