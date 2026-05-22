E-Fapiao-OCR standalone binary
Version: 0.1.3
Target: darwin-arm64
Flavor: lite

Usage:
  efapiao --version
  efapiao parse invoice.pdf --pretty
  efapiao serve --host 127.0.0.1 --port 8000

Notes:
- Release binaries include the rule engine and optional HTTP/Tencent OCR vendors.
- Linux builds require libzbar at runtime for QR decoding.
- CnOCR local model support is not bundled in this asset.
- Install optional deps separately with: pip install -e ".[ocr-cnocr]".