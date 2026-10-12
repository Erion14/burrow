#!/usr/bin/env bash
# Regenerates the PWA icons from the inline SVG below. Needs ImageMagick (magick).
set -euo pipefail

out="$(cd "$(dirname "$0")/.." && pwd)/src/web/icons"
mkdir -p "$out"

svg='<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#1e1e2e"/>
  <path d="M96 400 V248 C96 160 168 96 256 96 C344 96 416 160 416 248 V400 Z" fill="#cba6f7"/>
  <path d="M168 400 V264 C168 208 208 168 256 168 C304 168 344 208 344 264 V400 Z" fill="#11111b"/>
  <path d="M212 400 V280 C212 252 230 232 256 232 C282 232 300 252 300 280 V400 Z" fill="#89b4fa"/>
  <rect x="64" y="400" width="384" height="24" rx="12" fill="#45475a"/>
</svg>'

for size in 192 512; do
	printf '%s' "$svg" | magick -background none -density 384 svg:- -resize "${size}x${size}" "$out/icon-${size}.png"
done
