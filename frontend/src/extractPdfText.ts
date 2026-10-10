import * as pdfjsLib from "pdfjs-dist"
import type { TextItem } from "pdfjs-dist/types/src/display/api"

// Point at the bundled worker — Vite resolves this at build time
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString()

export type PdfExtractionResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: "scanned" | "error"; message: string }

export async function extractPdfText(file: File): Promise<PdfExtractionResult> {
  try {
    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

    const pageTexts: string[] = []

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .filter((item): item is TextItem => "str" in item)
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      pageTexts.push(pageText)
    }

    const fullText = pageTexts.join("\n\n").trim()

    // Heuristic: fewer than 50 meaningful characters across all pages = likely scanned
    const meaningfulChars = fullText.replace(/\s/g, "").length
    if (meaningfulChars < 50) {
      return {
        ok: false,
        reason: "scanned",
        message:
          "This appears to be a scanned PDF. Text extraction requires OCR — scanned document support is coming soon.",
      }
    }

    return { ok: true, text: fullText, pages: pdf.numPages }
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "Failed to read PDF",
    }
  }
}
