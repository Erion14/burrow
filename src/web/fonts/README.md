# Burrow Mono

`burrow-mono-regular.woff2` and `burrow-mono-bold.woff2` are subsets of
JetBrains Mono Nerd Font Mono. The phone bundles them as the CSS family
"Burrow Mono" (see `src/web/styles.css`) so every nerd glyph the UI prints
renders without a locally installed Nerd Font.

## Provenance

- Source: `~/.local/share/fonts/JetBrainsMonoNerdFontMono-Regular.ttf` and
  `~/.local/share/fonts/JetBrainsMonoNerdFontMono-Bold.ttf` (JetBrains Mono,
  Nerd Font Mono patched build).
- License: SIL Open Font License 1.1, see `OFL.txt` beside these files.
- The source is not committed: only the two subsets and this text are.

## Subsetting

`pyftsubset` (fonttools, `pip install "fonttools[woff]"`) produced both files
with the command below, once per weight. The unicode list is the nerd font
range set minus the Material Design Icons plane; it reproduces the committed
files byte for byte.

```sh
UNICODES="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+2001,U+200B,U+2010,U+2013-2014,U+2016,U+2018-2022,U+2024,U+2026,U+2030,U+2032-2034,U+2039-203A,U+203C-203F,U+2044-2046,U+2070,U+2074-207A,U+207C,U+2080-2089,U+20AB-20AC,U+20AE,U+20B4,U+20BD,U+20BF,U+2102,U+210D,U+2113,U+2115-2116,U+2119-211A,U+211D,U+2122,U+2124,U+212E,U+2140,U+2190-2199,U+219D-219E,U+21A0,U+21A2-21A3,U+21A5-21A7,U+21A9-21AA,U+21AD,U+21BE,U+21C9,U+21D0-21D4,U+21DB,U+21DE-21DF,U+21E5,U+21E7-21E8,U+21EA,U+2200-220C,U+220E-2213,U+2215,U+2218-221A,U+221E,U+2223-2225,U+2227-222B,U+2234-2239,U+223C,U+223E,U+2243,U+2245,U+2247-2249,U+224B,U+224D,U+2254,U+2257,U+225F-2265,U+226A-2273,U+227A-227C,U+2282-2289,U+228E-2299,U+229B-22A5,U+22B4,U+22B8,U+22BB-22BD,U+22C2-22C4,U+22C6,U+22C8-22CA,U+22CE,U+22D0,U+22E2,U+22EE-22F1,U+2302-2305,U+2308-230B,U+2318,U+231C-231F,U+2324-2326,U+2328,U+232B,U+2336-237A,U+2389-238B,U+2395,U+239B-23AD,U+23CE,U+23FB-23FE,U+2500-25A1,U+25AA-25AB,U+25B2-25CC,U+25CE-25CF,U+25D4-25D5,U+25E6-25EB,U+25EF,U+25F6,U+2630,U+2665,U+266D,U+266F,U+2687,U+26A0-26A1,U+2713,U+2715,U+2717,U+2736,U+276C-2771,U+2794,U+279C-279E,U+27DC,U+2800-28FF,U+2B58,U+E0A0-E0A3,U+E0B0-E0C8,U+E0CA,U+E0CC-E0D2,U+E0D4,U+E0D6-E0D7,U+E200-E2A9,U+E300-E3E3,U+E5FA-E6BB,U+E700-E958,U+EA60-EA88,U+EA8A-EA8C,U+EA8F-EAC7,U+EAC9,U+EACC-EB09,U+EB0B-EB4E,U+EB50-EC5E,U+EC60-EC84,U+ED00-EFCF,U+F000-F385,U+F400-F533"

pyftsubset ~/.local/share/fonts/JetBrainsMonoNerdFontMono-Regular.ttf \
	--output-file=burrow-mono-regular.woff2 \
	--flavor=woff2 \
	--layout-features='*' \
	--no-hinting \
	--name-IDs='*' \
	--unicodes="$UNICODES"

pyftsubset ~/.local/share/fonts/JetBrainsMonoNerdFontMono-Bold.ttf \
	--output-file=burrow-mono-bold.woff2 \
	--flavor=woff2 \
	--layout-features='*' \
	--no-hinting \
	--name-IDs='*' \
	--unicodes="$UNICODES"
```

The upstream nerd font range list also carries the Material Design Icons plane
(`U+F0001-F1AF0`, 6896 glyphs). It was dropped here on purpose: nothing in the
Burrow UI uses it and it would roughly double the file size. Every other glyph
the UI prints (codicons, devicons, powerline, box drawing, braille spinner
frames) stays in.

The build resolves the `@font-face` urls and emits both files into `/assets`
with a content hash (see `tools/build-web.ts`), which is why `styles.css`
references them with a relative path and `index.html` preloads the hashed
names.
