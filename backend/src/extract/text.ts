/**
 * Normalises clinician text: page markers out (the handout's "--- page N", pdf-parse's "-- N of M --",
 * a bare "Page N of M"), line endings unified, whitespace tidy, bullets kept.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*-{2,}\s*page\s+\d+(?:\s+of\s+\d+)?\s*-*\s*$/gim, "")
    .replace(/^\s*-{2,}\s*\d+\s+of\s+\d+\s*-{2,}\s*$/gm, "")
    .replace(/^\s*page\s+\d+(?:\s+of\s+\d+)?\s*$/gim, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isEmptyText(input: string | undefined | null): boolean {
  return !input || normalizeText(input).length === 0;
}
