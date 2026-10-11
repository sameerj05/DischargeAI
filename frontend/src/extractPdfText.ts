import * as pdfjsLib from "pdfjs-dist"
import type { TextItem } from "pdfjs-dist/types/src/display/api"

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
    const meaningfulChars = fullText.replace(/\s/g, "").length

    if (meaningfulChars < 50) {
      return {
        ok: false,
        reason: "scanned",
        message: "This appears to be a scanned PDF. Scanned document support via OCR is coming soon.",
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
