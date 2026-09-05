# Supporting documents

Filename classification and E-Fapiao content classification are additive: either
signal makes a document `supporting`. Reimbursable flight itineraries remain
`itinerary`. Filename detection covers toll summaries, order details, settlement
sheets and the existing supporting-material patterns.

| E-Fapiao document_type | MFH documentType | MFH invoiceType | OCR result status |
| --- | --- | --- | --- |
| pdf-supporting | supporting | unchanged invoice_type | success |
| ofd-supporting | supporting | unchanged invoice_type | success |
| image-supporting | supporting | unchanged invoice_type | success |

Expected invoice types are `toll_summary`, `order_detail`, `settlement`, and
`supporting_other`. Supporting documents do not need invoice core fields.
The existing results CSV has no title or remarks column: **only for supporting
rows**, `seller` stores `extra.title` as a display label. Amount, invoice number
and date fields are blank. `transport` remains cli/http and `error` remains empty
for successful classification. Related invoice numbers remain in the raw provider
payload; they are not copied into the invoice number column. The CSV schema is
unchanged and does not persist those related-number arrays.

`library.total` counts all invoice-like documents, including reimbursable
itineraries and pending/failed invoices, excluding supporting material.
`library.invoiceLike` is that total minus itineraries. `recognized` counts complete
invoice-like rows. `statusCounts` excludes supporting rows and sums to `total`.
`supporting` counts the retained supporting rows; `documentTotal` counts all rows
for pagination. Supporting rows remain available with `documentType: supporting`
and archived status in the library and mail detail views.

`archive.keepSupporting` defaults to `true`, including migrated configurations,
and is exposed through get-config/save-config. Set it to `false` to skip archiving
attachments recognized as supporting before OCR; logs include `supporting_skipped`.
A mixed mail archives its invoices normally. Supporting-only mail remains pending
with `only_supporting_documents:…`. Content-only classification happens after
archiving, so this flag does not remove those files or clean up existing archives.

Invoice CSV export and `mfh organize` omit supporting rows by default.
`mfh organize --include-supporting` also copies retained supporting material
(including filename-classified OCR queue entries when using default results).
Invoice-number and container dedupe exclude supporting files.

The physical archive, archive ledger, internal OCR CSVs, library All view, and mail
attachment/detail views still contain retained supporting material. OCR run totals
can report a successful supporting classification as a parsed document; it is not
counted as a recognized invoice in the library/OCR summary.
