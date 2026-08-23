export const ROOT_USAGE = `mfh — Mail Fapiao Helper

Usage:
  mfh <command> [options]

Commands:
  fetch          Fetch matching mails as .eml into samples/raw/
  run            Process emails and extract invoices
  ocr            Run OCR for archived documents
  pending        Inspect manual processing queue
  organize       Copy archived invoices into optional OCR-based names/folders
  rebuild-state  Rebuild state.json from INDEX/cache/invoices.csv (no data deleted)

Options:
  -h, --help    Show this help

Run 'mfh <command> --help' for command-specific options.
`;

export const PENDING_USAGE = `mfh pending — inspect manual processing queue

Usage:
  mfh pending <command> [options]

Commands:
  list    List emails currently in pending.csv

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --json               Print machine-readable summary for GUI integration
  -h, --help           Show this help
`;

export const ORGANIZE_USAGE = `mfh organize — copy archived invoices into optional OCR-based names/folders

Usage:
  mfh organize [options]

Options:
  --config <path>       Path to config.json                 (default: ./config.json)
  --results-csv <path>  OCR result CSV to consume           (default: config.ocr.resultsCsv)
  --out <dir>           Organized output directory          (default: config.rename.organizedDir)
  --apply-rename        Force OCR-based renaming for this run (overrides config.rename.applyAfterOcr)
  --no-apply-rename     Disable OCR-based renaming for this run
  -h, --help            Show this help

Notes:
  * This command does not call OCR or LLM providers.
  * It never moves or overwrites the original files in config.paths.invoices.
`;

export const OCR_USAGE = `mfh ocr — run OCR for archived documents

Usage:
  mfh ocr <command> [options]

Commands:
  run      Parse documents listed in invoices/ocr/ocr-pending.csv
  summary  Summarize recognized / failed / ignored OCR queue state

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --force              Re-parse rows already present in ocr.resultsCsv
  --single-item        Parse files one by one for visible progress and checkpoint resume
  --concurrency <n>    Parse up to N files in parallel
  --allow-parse-failures
                       Exit 0 when OCR transport completed but some rows failed to parse
  --json               Print machine-readable summary for GUI integration
  -h, --help           Show this help
`;

export const FETCH_USAGE = `mfh fetch — fetch matching mails as .eml

Usage:
  mfh fetch [options]

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --state <path>       Path to state.json         (default: ./state.json)
  --out <dir>          Output dir for samples     (default: config.paths.samples)
  --since-days <n>     Use a rolling N-day window (overrides config.filter.sinceDays)
  --since <date>       Lower bound, inclusive     (YYYY-MM-DD or ISO 8601)
  --until <date>       Upper bound, inclusive     (YYYY-MM-DD or ISO 8601)
  --dry-run            Do not write files; only log what would happen
  -h, --help           Show this help

Notes:
  * --since / --until take precedence over --since-days (and the corresponding
    config fields). You can use either bound alone.
  * Both bounds accept whole-day dates (YYYY-MM-DD) or full ISO timestamps.
  * YYYY-MM-DD is interpreted in the LOCAL calendar: --until 2026-07-27 includes
    the whole local day. A full ISO timestamp keeps its exact instant and is
    never widened by 24 hours.
`;

export const REBUILD_STATE_USAGE = `mfh rebuild-state — rebuild state.json from on-disk evidence

Usage:
  mfh rebuild-state [options]

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --state <path>       Path to state.json         (default: ./state.json)
  --out <dir>          Cached mail dir to scan    (default: config.paths.samples)
  --dry-run            Only report what would be rebuilt
  -h, --help           Show this help

Notes:
  * Only state.json is rewritten. Cached .eml files, INDEX.csv, invoices.csv,
    archived documents and the pending queue are never deleted or modified.
  * A corrupt state.json is moved aside to a timestamped .bak first.
`;

export const RUN_USAGE = `mfh run — process emails and extract invoices

Usage:
  mfh run [options]

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --state <path>       Path to state.json         (default: ./state.json)
  --only-mail <hash>   Process one msgIdHash, even if already processed
  --concurrency <n>    Process up to N cached emails in parallel (default: 4)
  --force              Re-process cached emails even if state says they were handled
  -h, --help           Show this help
`;
