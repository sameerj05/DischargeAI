import { normalizeText } from "./text.js";

/**
 * The team contract's "Backend: Convert PDF to text. Function to convert passed pdf to text, to be
 * used by the main ingester." pdf-parse v2 (`PDFParse` class) first, pdfjs-dist legacy build as the
 * fallback. Both verified on the hackathon handout PDF. Pure: bytes in, text out, no I/O.
 */
export interface PdfText {
  text: string;
  pages: number;
  engine: "pdf-parse" | "pdfjs-dist";
}

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export function looksLikePdf(buf: Buffer): boolean {
  return buf.length > PDF_MAGIC.length && buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/** POST /ingest `{ "type": "pdf", "data": ... }` carries the PDF as base64, with or without a `data:application/pdf;base64,` prefix. */
export function decodePdfData(data: string): Buffer {
  const trimmed = data.trim();
  const comma = trimmed.startsWith("data:") ? trimmed.indexOf(",") : -1;
  const payload = (comma >= 0 ? trimmed.slice(comma + 1) : trimmed).replace(/\s+/g, "");
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || !/^[A-Za-z0-9+/]+=*$/.test(normalized)) return Buffer.alloc(0);
  return Buffer.from(normalized, "base64");
}

export async function pdfToText(buf: Buffer): Promise<PdfText> {
  if (!looksLikePdf(buf)) throw new Error("not a PDF (missing %PDF- header)");
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    try {
      const r = await parser.getText();
      const text = normalizeText(r.text ?? "");
      if (text.length > 0) return { text, pages: r.total ?? 0, engine: "pdf-parse" };
    } finally {
      await parser.destroy();
    }
  } catch {
    /* fall through to pdfjs */
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    parts.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
  }
  const text = normalizeText(parts.join("\n\n"));
  if (!text) throw new Error("PDF contained no extractable text");
  return { text, pages: doc.numPages, engine: "pdfjs-dist" };
}

/** Earlier name of the same function, kept for callers that import it. */
export const extractPdfText = pdfToText;
