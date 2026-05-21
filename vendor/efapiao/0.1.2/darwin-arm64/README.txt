E-Fapiao-OCR standalone binary
Version: 0.1.2
Target: darwin-arm64

Usage:
  efapiao --version
  efapiao parse invoice.pdf --pretty
  efapiao serve --host 127.0.0.1 --port 8000

Notes:
- Release binaries include the rule engine and optional HTTP/Tencent OCR vendors.
- CnOCR local model support is intentionally not bundled in default release assets.
- Linux builds require libzbar at runtime for QR decoding.