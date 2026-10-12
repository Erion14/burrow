#!/usr/bin/env bash
# Regenerates the PWA icons from the inline SVG below. Needs ImageMagick (magick).
set -euo pipefail

out="$(cd "$(dirname "$0")/.." && pwd)/src/web/icons"
mkdir -p "$out"

# omp dark-rainforest: orchidPurple (accent) arch on canopyBlack, framed in barkBorder
# like a TUI box. The arch path matches BurrowMark in src/web/screens/icons.tsx.
svg='<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0A0D0B"/>
  <rect x="40" y="40" width="432" height="432" rx="20" fill="none" stroke="#2A3A2D" stroke-width="8"/>
  <path fill-rule="evenodd" fill="#B07AD9" d="M112 392 V252 C112 166 176 112 256 112 C336 112 400 166 400 252 V392 Z M188 392 V274 C188 236 218 208 256 208 C294 208 324 236 324 274 V392 Z"/>
</svg>'

for size in 192 512; do
	printf '%s' "$svg" | magick -background none -density 384 svg:- -resize "${size}x${size}" "$out/icon-${size}.png"
done
