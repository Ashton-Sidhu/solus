const INLINE_RASTER_IMAGE =
  /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** Pasted task screenshots may be inlined; executable image formats may not. */
export function isInlineTaskImageUrl(url: string): boolean {
  return INLINE_RASTER_IMAGE.test(url);
}
