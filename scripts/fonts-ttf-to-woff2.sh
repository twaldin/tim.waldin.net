#!/bin/bash
# Convert TTF fonts in frontend/public/fonts/ to woff2. Uses Python's
# fontTools (auto-installs if missing). woff2 cuts ~55-60% off the
# uncompressed TTF size and is natively supported by all modern browsers.
#
# Usage:
#   scripts/fonts-ttf-to-woff2.sh                 all *.ttf
#   scripts/fonts-ttf-to-woff2.sh Regular Bold    match only names containing these substrings
#   scripts/fonts-ttf-to-woff2.sh --force         overwrite existing .woff2
#   scripts/fonts-ttf-to-woff2.sh --subset Regular Bold --force
#     retain the legacy selection of Latin, box/block drawing, symbols and
#     private-use glyphs, not the full Nerd Font set; removes other glyphs and
#     hinting. Use ordinary conversion above for complete glyph coverage.

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
require_repo_root

fonts_dir="${REPO_ROOT}/frontend/public/fonts"
[[ -d "${fonts_dir}" ]] || die "no fonts dir at ${fonts_dir}"

force=0
subset=0
patterns=()
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --subset) subset=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) patterns+=("$arg") ;;
  esac
done

# ---- Ensure fontTools is installed -------------------------------------------

if ! python3 -c 'from fontTools.ttLib import TTFont' 2>/dev/null; then
  log_info "installing fontTools + brotli..."
  if ! pip3 install fonttools brotli --break-system-packages 2>&1 | tail -3; then
    die "pip3 install failed — install fonttools manually"
  fi
fi

# ---- Find candidate TTFs -----------------------------------------------------

candidates=()
shopt -s nullglob
for f in "${fonts_dir}"/*.ttf; do
  name="$(basename "${f}")"
  if (( ${#patterns[@]} == 0 )); then
    candidates+=("${f}")
  else
    for p in "${patterns[@]}"; do
      if [[ "${name}" == *"${p}"* ]]; then
        candidates+=("${f}")
        break
      fi
    done
  fi
done
shopt -u nullglob

(( ${#candidates[@]} > 0 )) || die "no matching TTFs in ${fonts_dir}"

# ---- Convert -----------------------------------------------------------------

total_in=0
total_out=0

for ttf in "${candidates[@]}"; do
  woff2="${ttf%.ttf}.woff2"
  name="$(basename "${ttf}")"

  if [[ -f "${woff2}" ]] && (( ! force )); then
    log_dim "  skip (already exists): $(basename "${woff2}")"
    continue
  fi

  if (( subset )); then
    python3 -m fontTools.subset "${ttf}" \
      --output-file="${woff2}" --flavor=woff2 \
      --unicodes="U+0020-007E,U+00A0-00FF,U+2500-257F,U+2580-259F,U+25A0-25FF,U+2600-26FF,U+E000-E0FF,U+E0A0-E0FF,U+F000-F8FF" \
      --layout-features='*' --no-hinting
  else
    python3 -c '
import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1])
f.flavor = "woff2"
f.save(sys.argv[2])
' "${ttf}" "${woff2}"
  fi
  in_size=$(stat -f%z "${ttf}" 2>/dev/null || stat -c%s "${ttf}")
  out_size=$(stat -f%z "${woff2}" 2>/dev/null || stat -c%s "${woff2}")
  total_in=$((total_in + in_size))
  total_out=$((total_out + out_size))
  pct=$(( 100 - out_size * 100 / in_size ))
  printf '  %s  %s → %s  (%s%% smaller)\n' \
    "${name}" \
    "$(human_bytes "${in_size}")" \
    "$(human_bytes "${out_size}")" \
    "${pct}"
done

if (( total_in > 0 )); then
  overall=$(( 100 - total_out * 100 / total_in ))
  log_ok "total: $(human_bytes "${total_in}") → $(human_bytes "${total_out}") (${overall}% smaller)"
fi
