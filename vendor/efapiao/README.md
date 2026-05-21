# E-Fapiao-OCR binaries

Bundled release binaries for `12dora/E-Fapiao-OCR`.

Directory layout:

```text
vendor/efapiao/<version>/<platform-arch>/efapiao
vendor/efapiao/<version>/<platform-arch>/efapiao.exe
```

Supported platform directory names used by `ocr.binaryPath = "auto"`:

- `darwin-arm64`
- `darwin-x86_64`
- `linux-x86_64`
- `linux-arm64`
- `windows-x86_64`

Currently bundled:

- `0.1.2/darwin-arm64/efapiao`

For missing platforms, place the matching upstream release asset in the same layout. If no bundled binary exists for the current platform, the app falls back to `efapiao` from `PATH`.
