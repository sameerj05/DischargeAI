-- Translation is not part of ingestion: POST /ingest no longer takes or stores a language, so the
-- column that held "the language the provider picked at ingest" goes. `languages` (the languages the
-- summary item currently holds, English first) stays; GET /translation maintains it.
ALTER TABLE activeLinks DROP COLUMN language;
