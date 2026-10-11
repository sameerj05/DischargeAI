import multer from "multer";

/** Multipart handling for POST /ingest: one PDF (`file`) or one audio clip (`audio`), kept in memory. */
export function uploadMiddleware(maxBytes: number) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 2 },
  });
  return upload.fields([
    { name: "file", maxCount: 1 },
    { name: "audio", maxCount: 1 },
  ]);
}

export type UploadedFiles = Record<string, Express.Multer.File[] | undefined>;
