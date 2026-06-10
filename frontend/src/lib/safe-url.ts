// Allow only schemes safe to hand to window.open from terminal/markdown
// output. Blocks javascript:, data:, vbscript:, blob:, file:, etc.
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternalUrl(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false; // not an absolute URL with a parseable scheme → don't open
  }
  return SAFE_SCHEMES.has(url.protocol);
}
