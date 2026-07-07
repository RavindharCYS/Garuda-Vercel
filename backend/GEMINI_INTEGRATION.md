# Gemini Accuracy Layer — What Changed

## New files
- `services/geminiService.js` — calls the Gemini API to extract AWB fields from
  raw OCR text. Single-record (`extractFields`) and batch (`extractFieldsBatch`)
  modes. Uses Gemini's `responseSchema` (structured output) so it always returns
  valid JSON matching your field shape — no prompt-engineering JSON parsing hacks.
- `services/waybillFieldSchema.js` — single source of truth for the 27-field AWB
  schema, shared by the merge logic and the Gemini schema (kept in sync with
  `services/parsers/base_parser.py` blank_fields()).
- `.env.example` — every env var the backend reads, including the new `GEMINI_*` ones.
- `.gitignore` — added (there wasn't one) so `.env`, the sqlite DB, logs, and
  uploaded waybills (PII) never get committed.

## Modified files
- `services/ocrService.js`
  - `extractWaybillDataRaw()` — the old engine-selection logic (Google Vision ->
    Tesseract), unchanged behavior, just renamed/exposed for internal reuse.
  - `extractWaybillData()` — same single-file entry point as before, now ALSO
    sends the OCR'd raw text to Gemini and merges in whatever Gemini fills,
    Gemini's value wins; if Gemini is unset/fails/times out, behaves exactly
    like before (no regression — Gemini is purely additive).
  - `extractWaybillDataBatch(filePaths)` — **new**. OCRs every file, then sends
    ALL of their raw text to Gemini in **one batched request** (the `AWB 1 /
    ======== / <text>` format you described), instead of one Gemini call per
    file. Internally chunked (`GEMINI_BATCH_SIZE`, default 5) since accuracy
    degrades on very large batches — bigger jobs become multiple chunked
    requests automatically. Each file's OCR failure is isolated and reported
    individually; it never aborts the rest of the batch.
- `services/bulkUploadService.js` — `processDocumentBatchUpload` (ZIP/PDF bulk
  upload) now calls `extractWaybillDataBatch()` once for the whole batch
  instead of looping `extractWaybillData()` per file.
- `routes/shipments.js` — the legacy `/api/shipments/bulk-upload` (multi-file
  scan) endpoint now uses the same batch path for the same reason.
- `utils/initDb.js` — seeds a new `ocr_gemini_enrichment` system setting
  (`'1'`/`'0'`) so enrichment can be toggled off at runtime without removing
  the API key.

## Error handling added
- Retries with exponential backoff (+ `Retry-After` honoring) on 429/5xx/network
  errors, configurable via `GEMINI_MAX_RETRIES` / `GEMINI_TIMEOUT_MS`.
- Defensive JSON parsing (strips stray ```json fences even though structured
  output makes this rare).
- Batch count-mismatch detection: if Gemini returns the wrong number of
  records for a chunk, that chunk is automatically re-run record-by-record
  rather than risking fields getting assigned to the wrong AWB.
- Every Gemini call is logged to the existing `api_logs` table via
  `logApiCall()` (provider `'gemini'`) — it shows up in the Admin Dashboard
  "API Health" widget automatically, no extra wiring needed.
- At every integration point, a Gemini failure degrades gracefully back to the
  regex-only OCR result instead of failing the request — Gemini being down,
  unconfigured, or rate-limited can only ever leave accuracy where it was
  before, never break OCR.

## Setup
1. Get a free Gemini API key (no card required): https://aistudio.google.com/apikey
2. Copy `.env.example` to `.env` in the `backend/` folder.
3. Set `GEMINI_API_KEY=<your key>`.
4. `npm install` (no new dependencies were added — `axios` and `dotenv` are
   already in `package.json`).
5. Restart the server. Single uploads (`/api/shipments/upload-ocr`) and bulk
   uploads (`/api/bulk-upload`, `/api/shipments/bulk-upload`) all pick it up
   automatically — no frontend changes required, the response shape is the
   same, just with better-filled `fields` and an `engine` value like
   `"tesseract+gemini"` so you can see when it kicked in.

## A note on the free tier
Gemini's free tier is rate-limited (roughly 5–15 requests/minute and
100–1,000/day depending on the model as of mid-2026). The batch path above
exists specifically so a 30-file bulk upload costs ~6 Gemini requests (at the
default batch size of 5) instead of 30. If you're still hitting 429s under
load, lower `GEMINI_BATCH_SIZE` won't help with *rate*, but raising
`GEMINI_MAX_RETRIES` / using `gemini-2.5-flash-lite` (higher daily quota) will.
