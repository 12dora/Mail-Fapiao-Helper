# E-Fapiao-OCR binaries

Bundled release binaries for `12dora/E-Fapiao-OCR`.

Directory layout:

```text
vendor/efapiao/<version>/<platform-arch>/efapiao
vendor/efapiao/<version>/<platform-arch>/efapiao.exe
```

Supported platform directory names used by `ocr.binaryPath = "auto"`:

- `darwin-arm64`
- `windows-x86_64`

Currently bundled:

- `0.1.3/darwin-arm64/efapiao`
- `0.1.3/windows-x86_64/efapiao.exe`

These are the upstream `v0.1.3` `lite` release assets. `lite` intentionally
does not include CnOCR models, keeping the default bundle smaller and suitable
for rule-engine parsing, Tencent OCR, or HTTP OCR.

To use upstream `with-model` packages, replace the matching platform directory
with the extracted `with-model` contents or place its `models/` directory beside
the `efapiao` binary. The app auto-detects that directory and sets
`EFAPIAO_OCR_VENDOR=cnocr` unless the user explicitly configured another OCR
vendor.

Upstream `v0.1.3` does not publish a `darwin-x86_64` release asset. Intel Mac
users should build it upstream or put an `efapiao` binary on `PATH`.

Linux binaries are intentionally not bundled because the desktop app currently
targets macOS and Windows only.
