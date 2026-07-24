#!/usr/bin/env bash
# font-cycle.sh v3 — slot-machine font cycler. Reads a font manifest
# (lines: `Display Name|width|height|flf_filename`), keeps fonts narrow
# enough for the terminal (width <= COLUMNS-2), renders 7-9 of them LIVE via
# figlet in rapid accelerating succession (~170ms -> ~80ms, name captioned
# under each), then settles.
#
# Settle frame (v3 contract):
#   - If BOOT_BANNER_FILE (default /tmp/boot-banner.txt) exists and is
#     non-empty, the FINAL frame is exactly that file's content (boot.sh owns
#     the settle font so welcome/resume re-render the same banner). The cycle
#     still shows the other fonts first.
#   - Otherwise the final frame is the last cycled font's render.
#   - Banner's FIRST line lands on terminal row 1, nothing else on screen,
#     cursor parked EXACTLY one row below the last banner line. No \033[2J
#     anywhere. Ends with \033[0m, autowrap restored, cursor visible, exit 0.
#
# Env overrides (testing): FONTS_MANIFEST, FONTS_DIR (default
# /usr/share/figlet/custom), FIGLET, BOOT_BANNER_FILE. If the manifest is
# missing/empty or no pool font fits, a built-in stock-font pool is used.
# Fonts not found under FONTS_DIR fall back to stock figlet -f name lookup.
set -u
# wc -L must measure DISPLAY columns, not bytes — block/braille glyphs are
# 3 bytes each; without a UTF-8 locale wc -L triples the width and every
# frame clamps to left=1 (the 'not centered' bug).
export LC_ALL=C.UTF-8

cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
rows=${LINES:-$(tput lines 2>/dev/null || echo 24)}
[ "$cols" -gt 0 ] 2>/dev/null || cols=80
[ "$rows" -gt 0 ] 2>/dev/null || rows=24

FIGLET=${FIGLET:-figlet}
FONTS_DIR=${FONTS_DIR:-/usr/share/figlet/custom}
BANNER_FILE=${BOOT_BANNER_FILE:-/tmp/boot-banner.txt}

maxw=$(( cols - 2 )); [ "$maxw" -lt 8 ] && maxw=8

# ---------------- font pool ----------------
manifest=${FONTS_MANIFEST:-}
if [ -z "$manifest" ]; then
  for m in /home/portfolio/scripts/fonts.txt /work/fonts.txt; do
    if [ -s "$m" ]; then manifest=$m; break; fi
  done
fi

names=(); flfs=(); widths=()
add_pool_line() {                      # $1 = "Display Name|width|height|flf"
  local line=$1 n w f
  case "$line" in ''|'#'*) return 0 ;; esac
  n=${line%%|*}; line=${line#*|}
  w=${line%%|*}; line=${line#*|}
  line=${line#*|}                      # drop height (derived from live render)
  f=${line%%|*}
  [ -n "$n" ] && [ -n "$f" ] || return 0
  case "$w" in ''|*[!0-9]*) return 0 ;; esac
  [ "$w" -le "$maxw" ] || return 0
  names+=("$n"); flfs+=("$f"); widths+=("$w")
}

if [ -n "$manifest" ] && [ -s "$manifest" ]; then
  while IFS= read -r line; do add_pool_line "$line"; done < "$manifest"
fi

if [ "${#names[@]}" -eq 0 ]; then      # built-in stock pool (name|w|h|font)
  builtin=(
    "Big|35|6|big"        "Standard|35|5|standard" "Slant|36|5|slant"
    "Small|31|4|small"    "Mini|19|3|mini"         "Lean|68|6|lean"
    "Block|68|6|block"    "Digital|15|3|digital"   "Shadow|36|4|shadow"
    "Banner|43|7|banner"  "DOS Rebel|69|8|DOS_Rebel"
    "Small Slant|30|4|smslant" "Small Shadow|33|3|smshadow"
    "Script|39|5|script"
  )
  for line in "${builtin[@]}"; do add_pool_line "$line"; done
fi
if [ "${#names[@]}" -eq 0 ]; then      # nothing fits: retry unfiltered stock
  names=(Big Standard Slant Small Mini Digital Shadow)
  flfs=(big standard slant small mini digital shadow)
  widths=(35 35 36 31 19 15 36)
fi

# ---------------- narrow to a similar-width band ----------------
# Cycling fonts with wildly different column counts is jarring. Anchor on
# the settle font (boot.sh records its display name in /tmp/boot-font) and
# keep only fonts whose width is within a tolerance band of the anchor.
pool=${#names[@]}
anchor_w=""
if [ -s /tmp/boot-font ]; then
  bf=$(cat /tmp/boot-font)
  for ((i = 0; i < pool; i++)); do
    if [ "${names[i]}" = "$bf" ]; then anchor_w=${widths[i]}; break; fi
  done
fi
[ -z "$anchor_w" ] && anchor_w=${widths[$((RANDOM % pool))]}

tol=$(( anchor_w * 15 / 100 )); [ "$tol" -lt 6 ] && tol=6
while :; do
  keep=()
  for ((i = 0; i < pool; i++)); do
    d=$(( ${widths[i]} - anchor_w )); [ "$d" -lt 0 ] && d=$(( -d ))
    [ "$d" -le "$tol" ] && keep+=("$i")
  done
  [ "${#keep[@]}" -ge 4 ] && break
  [ "${#keep[@]}" -eq "$pool" ] && break
  tol=$(( tol * 2 )); [ "$tol" -gt 400 ] && break
done
if [ "${#keep[@]}" -gt 0 ] && [ "${#keep[@]}" -lt "$pool" ]; then
  bn=(); bf2=(); bw=()
  for i in "${keep[@]}"; do bn+=("${names[i]}"); bf2+=("${flfs[i]}"); bw+=("${widths[i]}"); done
  names=("${bn[@]}"); flfs=("${bf2[@]}"); widths=("${bw[@]}")
fi

# ---------------- pick & pre-render 7-9 fonts ----------------
pool=${#names[@]}
k=$(( 7 + RANDOM % 3 )); [ "$k" -gt "$pool" ] && k=$pool

# Fisher-Yates shuffle of indices, take first k
idx=(); for ((i = 0; i < pool; i++)); do idx+=("$i"); done
for ((i = pool - 1; i > 0; i--)); do
  j=$(( RANDOM % (i + 1) ))
  t=${idx[i]}; idx[i]=${idx[j]}; idx[j]=$t
done

# render one font; prints raw render, returns 1 if unusable
render() {                             # $1 = flf filename or stock name
  local try out dir
  for dir in "$FONTS_DIR" /home/portfolio/fonts /work/fonts; do
    [ -f "$dir/$1" ] || continue
    out=$("$FIGLET" -f "$dir/$1" -w 400 twaldin 2>/dev/null)
    if [ -n "$out" ]; then printf '%s\n' "$out"; return 0; fi
  done
  for try in "$1" "${1%.flf}"; do
    out=$("$FIGLET" -f "$try" -w 400 twaldin 2>/dev/null)
    if [ -n "$out" ]; then printf '%s\n' "$out"; return 0; fi
  done
  return 1
}

# trim trailing blank lines from stdin into array named by $1; set $1_w
load_lines() {                         # $1 = destination array name
  local -n _d=$1
  mapfile -t _d < <(awk '{l[NR]=$0; if ($0 ~ /[^ \t]/) last=NR}
                         END{for (i = 1; i <= last; i++) print l[i]}')
  if [ "${#_d[@]}" -gt 0 ]; then
    printf -v "$1_w" '%s' "$(printf '%s\n' "${_d[@]}" | wc -L | tr -d '[:space:]')"
  else
    printf -v "$1_w" 0
  fi
}

c_name=(); c_h=(); c_w=(); ncyc=0
for ((s = 0; s < k; s++)); do
  i=${idx[s]}
  out=$(render "${flfs[i]}") || continue
  [ -n "$out" ] || continue
  load_lines "cyc$ncyc" <<< "$out"
  declare -n _c="cyc$ncyc" _cw="cyc${ncyc}_w"
  if [ "${#_c[@]}" -gt 0 ]; then
    c_name+=("${names[i]}"); c_h+=("${#_c[@]}"); c_w+=("$_cw")
    ncyc=$(( ncyc + 1 ))
  fi
  unset -n _c _cw
done

# ---------------- final banner ----------------
final_from_file=0
if [ -s "$BANNER_FILE" ]; then
  load_lines fin < "$BANNER_FILE"
  [ "${#fin[@]}" -gt 0 ] && final_from_file=1
fi
if [ "$final_from_file" -eq 0 ]; then
  if [ "$ncyc" -gt 0 ]; then          # settle on the LAST cycled render
    declare -n _f="cyc$(( ncyc - 1 ))" _fw="cyc$(( ncyc - 1 ))_w"
    fin=("${_f[@]}"); fin_w=$_fw
    unset -n _f _fw
  else
    if command -v "$FIGLET" >/dev/null 2>&1; then
      out=$("$FIGLET" -f DOS_Rebel -w 400 twaldin 2>/dev/null)
      [ -n "$out" ] && load_lines fin <<< "$out"
    fi
    if [ "${#fin[@]}" -eq 0 ]; then fin=("twaldin"); fin_w=7; fi
  fi
fi
fh=${#fin[@]}
parkrow=$(( fh + 1 )); [ "$parkrow" -gt "$rows" ] && parkrow=$rows

# ---------------- drawing ----------------
occupied=0                             # highest terminal row touched so far

draw_banner() {                        # $1=array name $2=width $3=label(or "")
  local -n B=$1; local w=$2 label=${3:-} h r lr used ll left
  h=${#B[@]}
  left=$(( (cols - w) / 2 + 1 )); [ "$left" -lt 1 ] && left=1
  for ((r = 0; r < h; r++)); do
    printf '\033[%d;1H\033[2K\033[%d;%dH\033[32m%s' $((r + 1)) $((r + 1)) "$left" "${B[r]}"
  done
  used=$h; lr=0
  if [ -n "$label" ]; then
    lr=$(( h + 2 ))
    ll=$(( (cols - ${#label}) / 2 + 1 )); [ "$ll" -lt 1 ] && ll=1
    printf '\033[%d;1H\033[2K\033[%d;%dH\033[2;32m%s' "$lr" "$lr" "$ll" "$label"
    used=$lr
  fi
  for ((r = h + 1; r <= occupied; r++)); do   # clear rows gone stale
    [ "$r" -eq "$lr" ] && continue
    printf '\033[%d;1H\033[2K' "$r"
  done
  [ "$used" -gt "$occupied" ] && occupied=$used
}

draw_final() {
  draw_banner fin "$fin_w" ""
  printf '\033[%d;1H' "$parkrow"
}

finish() {
  draw_final
  printf '\033[0m\033[?7h\033[?25h'
  exit 0
}
trap finish INT TERM

# start: hide cursor, disable autowrap, scroll prompt into scrollback, home
printf '\033[?25l\033[?7l'
for ((i = 0; i < rows; i++)); do printf '\n'; done
printf '\033[H'

if [ "$ncyc" -gt 0 ]; then
  # accelerating dwell ~170ms -> ~80ms across the cycled fonts
  mapfile -t dwells < <(awk -v n="$ncyc" 'BEGIN{
    for (i = 0; i < n; i++) {
      d = (n > 1) ? 0.170 - 0.090 * i / (n - 1) : 0.150
      printf "%.3f\n", d
    }}')
  for ((i = 0; i < ncyc; i++)); do
    draw_banner "cyc$i" "${c_w[i]}" ""
    read -rsn1 -t "${dwells[i]}" && finish
  done
fi

# settle: complete final frame, skippable hold
draw_final
read -rsn1 -t 1.4 && finish
finish
