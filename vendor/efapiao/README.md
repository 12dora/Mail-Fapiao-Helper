# E-Fapiao-OCR binaries

Bundled engines from `12dora/E-Fapiao-OCR`, using the `lite` flavor:

| Desktop target | Packaged directory | State |
| --- | --- | --- |
| macOS arm64 | `0.1.4/darwin-arm64/` | Local upstream v0.1.4 build; archive SHA256 recorded in `0.1.4/SHA256SUMS` |
| Windows x64 | `0.1.3/windows-x86_64/` | Retained until the upstream v0.1.4 Windows release asset exists |

The old `0.1.3/darwin-arm64/` remains a repository fallback but is not packaged.
`ocr.binaryPath = "auto"` searches versions in order `0.1.4`, then `0.1.3`.
Within each version it searches `MFH_RESOURCE_ROOT`, `MFH_APP_ROOT`, then the
repository root, using the current platform directory (including one nested
archive directory). It logs the selected version when falling back to 0.1.3.
If none exists it uses `efapiao` on PATH; an explicit `ocr.binaryPath` takes
precedence. `resolvedBinaryVersion(config)` exports the selected bundled version
and returns `undefined` for custom/PATH engines. CSV `parserVersion` and
`ocrVendor` come from the engine response, not the directory name. In the local
v0.1.4 smoke test, the digital general PDF reports `source.parser_version`
`0.1.0`, while the toll summary and OFD report `0.1.4`. These parser versions
are intentionally preserved in the CSV; all three report a null OCR vendor
(stored as an empty CSV cell).

Packaging/audit versions are declared in `scripts/efapiao-vendor.mjs`.
`test:tooling` checks package.json resource/signing paths against that module.

## Finish the Windows upgrade

After the user pushes the upstream v0.1.4 tag and its release workflow publishes
the Windows asset and `SHA256SUMS`, run from this repository:

```sh
node scripts/fetch-efapiao.mjs --version 0.1.4 --platform windows-x86_64
```

Then:

1. Change both `build.win.extraResources[0].from` and `.to` in `package.json`
   to `vendor/efapiao/0.1.4/windows-x86_64`.
2. Change `win` to `0.1.4` in `scripts/efapiao-vendor.mjs`; the release audit
   reads that shared constant automatically.
3. On Windows, run `vendor/efapiao/0.1.4/windows-x86_64/efapiao.exe --version`
   and `capabilities`, then run the lint, build, typecheck, CLI, Electron and
   tooling gates. Package Windows and run `npm run verify:artifacts -- --platform win`
   with the appropriate release channel.
4. Update this table and the mixed-version notes in README.md and Dockerfile;
   commit the new vendor files/checksum and configuration changes together.

The fetch script defaults to `--flavor lite`, downloads the archive and release
checksum list, verifies SHA256 before extraction, and preserves other archive
checksums already recorded for that version. It prints the follow-up edits;
fetching alone does not change which version is packaged.

`lite` has no CnOCR models. It supports rule parsing and configured Tencent/HTTP
OCR. For local CnOCR, use the matching upstream `with-model` package or put its
`models/` beside the binary. The app detects that directory and defaults to
`EFAPIAO_OCR_VENDOR=cnocr` unless another vendor is configured.

The v0.1.4 lite capabilities report PDF `supported`, OFD `partial_supported`,
and image `not_implemented`. Document classes include `ofd-fapiao` and
`pdf-supporting` / `ofd-supporting` / `image-supporting`; listing a class does
not imply every format/layout is implemented without an OCR vendor.

Intel Macs need a locally built `darwin-x86_64` engine or one on PATH. Linux
engines are not bundled with desktop releases; for Docker, provide a matching
`0.1.4/linux-x86_64/efapiao` (or the current Linux architecture) yourself.
