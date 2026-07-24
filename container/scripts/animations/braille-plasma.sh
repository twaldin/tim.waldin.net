#!/usr/bin/env bash
# braille-plasma.sh — full-screen braille plasma intro.
# Sum-of-sines plasma evaluated per braille sub-pixel (2x4 per cell) using
# separable 1-D sine fields (FX/FY/diag) + a per-cell radial ripple, so each
# sub-pixel costs only a few array lookups. Rendered by a mawk coprocess that
# streams \001-delimited frames; bash paces playback and polls for keypresses
# (any key skips). After ~0.85s the plasma parts around a green "twaldin" banner
# that materializes cell-by-cell, then the plasma fully fades out leaving the
# banner alone. ~3.1s total incl. a >=1.3s static hold on the final banner.
#
# Colors: a GLOWING 256-color band (green->cyan->blue->teal, high brightness
# floor, seamless palindromic hue cycle) with bright light-cyan sparkle on the
# densest plasma crests. Contour bands are tightened for crisper structure.
# The persisted final banner is drawn in ANSI *slot* color 32 so the
# theme-strobe finale (OSC 9996, external) can re-color it.
#
# v3 end-contract: NEVER clears the screen with \033[2J. The banner text comes
# from ${BOOT_BANNER_FILE:-/tmp/boot-banner.txt} (plain-text figlet lines,
# 3-11 rows tall, width <= COLUMNS-2) so the font can vary per boot; height and
# display width are derived from the file at runtime. At start the shell prompt
# is scrolled up into scrollback (LINES newlines), then we animate in place
# with cursor addressing. On natural end OR any keypress we draw the COMPLETE
# final banner-only frame (every row cleared via \033[2K, then the banner
# pinned to the TOP rows — first line on row 1), park the cursor EXACTLY one
# row below the last banner line, restore SGR/autowrap/cursor, and exit — so
# the final frame persists on screen and in scrollback while welcome.sh prints
# below it.
set -u

# bash substring/${#} must be glyph-aware (figlet banners are UTF-8); mawk is
# locale-insensitive, so this is safe for the awk stage below.
export LC_ALL=C.UTF-8

cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
lines=${LINES:-$(tput lines 2>/dev/null || echo 24)}

# ---- v3 banner source -------------------------------------------------------
BANNER_FILE=${BOOT_BANNER_FILE:-/tmp/boot-banner.txt}
if [[ -s $BANNER_FILE ]]; then
  mapfile -t banner < "$BANNER_FILE"
else
  mapfile -t banner < <(figlet -f DOS_Rebel -w 400 twaldin 2>/dev/null)
fi
# trim trailing whitespace on each line (figlet pads), then trailing blank rows
for i in "${!banner[@]}"; do banner[i]=${banner[i]%"${banner[i]##*[![:space:]]}"}; done
while ((${#banner[@]})) && [[ -z ${banner[-1]} ]]; do unset 'banner[-1]'; done
((${#banner[@]})) || banner=('twaldin')
bh=${#banner[@]}
bw=$(printf '%s\n' "${banner[@]}" | wc -L)   # wc -L = display width (awk/bash length() are not)
(( bw < 1 )) && bw=1
if (( bw >= cols )); then banner=('t w a l d i n'); bh=1; bw=13; fi  # too wide: degrade to plain text

E=$'\033'
banner_top=1                            # v3: banner pinned to the TOP of the screen
pad=$(( (cols - bw) / 2 )); (( pad < 0 )) && pad=0
below_row=$(( banner_top + bh ))        # EXACTLY one row below the last banner line
(( below_row > lines )) && below_row=$lines

# explode each banner line into \001-delimited glyphs so the mawk animator
# (byte-based substr) can index whole multibyte characters per terminal cell
payload=''
for i in "${!banner[@]}"; do
  line=${banner[i]}
  for ((k = 0; k < ${#line}; k++)); do payload+="${line:k:1}"$'\001'; done
  payload+=$'\n'
done

# ---- precompute the clean, banner-only final frame --------------------------
# Every row is cleared with \033[2K (no \033[2J) so the full-screen plasma is
# wiped; the banner is drawn top-pinned and centered in slot color 32.
padstr=''; (( pad > 0 )) && printf -v padstr '%*s' "$pad" ''
final=''
for ((r = 1; r <= lines; r++)); do
  final+="${E}[${r};1H${E}[2K"
  if (( r >= banner_top && r < banner_top + bh )); then
    final+="${padstr}${E}[0;32m${banner[r - banner_top]}${E}[0m"
  fi
done

finish() {
  [[ -n ${AWKC_PID:-} ]] && kill "$AWKC_PID" 2>/dev/null
  printf '%s' "$final"                    # draw the COMPLETE banner-only frame
  printf '%s[%d;1H' "$E" "$below_row"     # park cursor one row below the banner
  printf '%s[0m%s[?7h%s[?25h' "$E" "$E" "$E"  # restore SGR, autowrap, cursor — NO 2J
  exit 0
}
trap 'finish' INT TERM

coproc AWKC { awk -v cols="$cols" -v rows="$lines" -v BW="$bw" -v BH="$bh" '
BEGIN {
  W = cols + 0; H = rows + 0
  PW = 2*W; PH = 4*H
  for (b = 0; b < 256; b++) BR[b] = sprintf("%c%c%c", 226, 160 + int(b/64), 128 + b%64)
  # GLOWING vivid band, green -> cyan -> teal -> blue, palindromic (seamless).
  # High brightness floor: every entry is a bright, saturated cube color.
  ng = split("46 47 48 49 50 51 45 44 43 38 39", g, " ")
  NC = 0
  for (i = 1; i <= ng; i++) CYC[NC++] = g[i]
  for (i = ng-1; i >= 2; i--) CYC[NC++] = g[i]
  for (k = 0; k < NC; k++) PC[k] = "\033[38;5;" CYC[k] "m"
  HL = "\033[38;5;159m"                                   # bright light-cyan crest sparkle
  # banner materialization gradient (dim -> bright brand green, ends on slot 32)
  BC[0] = "\033[38;5;22m"; BC[1] = "\033[38;5;28m"; BC[2] = "\033[38;5;34m"
  BC[3] = "\033[38;5;40m"; BC[4] = "\033[38;5;46m"; BC[5] = "\033[32m"
}
{ bl[NR] = $0 }
END {
  bh = BH; bw = BW
  for (r = 1; r <= bh; r++) {
    n = split(bl[r], tmp, "\001")                        # glyphs, pre-split by bash
    for (i = 1; i <= n; i++) cell[r, i] = tmp[i]
  }
  bx0 = int((W-bw)/2); if (bx0 < 0) bx0 = 0
  by0 = 0                                                # v3: banner pinned to the top rows
  gx0 = bx0-2; gx1 = bx0+bw+1; gy0 = by0-1; gy1 = by0+bh
  cx = (PW-1)/2; cy = (PH-1)/2
  for (r = 0; r < H; r++) for (c = 0; c < W; c++) {
    dxp = (2*c+0.5) - cx; dyp = (4*r+1.5) - cy
    DC[r*W+c] = sqrt(dxp*dxp + dyp*dyp) * 0.21
  }
  nf = 40; dt = 0.05; t2 = 0.85; fdur = 0.6; tf = t2 + fdur; fadedur = 0.5
  for (f = 0; f < nf; f++) {
    t = f*dt
    prog = (t - t2)/fdur; if (prog < 0) prog = 0; if (prog > 1) prog = 1
    fade = (t - tf)/fadedur; if (fade < 0) fade = 0; if (fade > 1) fade = 1
    th = -0.7 + prog*1.8 + fade*4.6              # dense glow; rises through reveal, then empties plasma
    cyco = t*2.2
    R = prog*14
    for (x = 0; x <= PW; x++) FX[x] = sin(x*0.13 + t*2.1) + sin(x*0.055 - t*1.3)
    for (y = 0; y <= PH; y++) FY[y] = sin(y*0.115 + t*1.6) + sin(y*0.048 + t*0.8)
    ns = PW + PH + 4
    for (s = 0; s <= ns; s++) FD[s] = sin(s*0.078 + t*1.9)
    # smooth low-frequency hue field (per cell): drives flowing green->cyan->
    # blue->teal color bands independent of the crisp high-freq density field.
    for (hc = 0; hc < W; hc++) HX[hc] = sin(hc*0.090 + t*0.75)
    for (hr = 0; hr < H; hr++) HY[hr] = sin(hr*0.170 + t*0.55)
    nh = W + H
    for (hs = 0; hs <= nh; hs++) HG[hs] = sin(hs*0.055 - t*0.50)
    gi = int(prog*6); if (gi > 5) gi = 5
    out = ""
    for (r = 0; r < H; r++) {
      row = "\033[" (r+1) ";1H"
      last = ""
      for (c = 0; c < W; c++) {
        if (prog > 0 && r >= by0 && r < by0+bh && c >= bx0 && c < bx0+bw) {
          bc = cell[r-by0+1, c-bx0+1]
          if (bc != " " && bc != "") {
            ha = ((c*73 + r*151) % 89) / 89.0
            if (prog > 0.25 + ha*0.7) {
              col = BC[gi]
              if (col != last) { row = row col; last = col }
              row = row bc
              continue
            }
          }
        }
        base = sin(DC[r*W+c] - t*2.6)
        if (prog > 0) {
          dx = (c < gx0) ? gx0-c : ((c > gx1) ? c-gx1 : 0)
          dy = (r < gy0) ? gy0-r : ((r > gy1) ? r-gy1 : 0)
          d = dx + 2*dy
          if (d < R) base -= (R-d)*1.0
        }
        px = c+c; py = 4*r; s0 = px+py
        fx0 = FX[px]; fx1 = FX[px+1]
        fy0 = FY[py]+base; fy1 = FY[py+1]+base; fy2 = FY[py+2]+base; fy3 = FY[py+3]+base
        b = 0
        if (fx0+fy0+FD[s0]   > th) b += 1
        if (fx1+fy0+FD[s0+1] > th) b += 8
        if (fx0+fy1+FD[s0+1] > th) b += 2
        if (fx1+fy1+FD[s0+2] > th) b += 16
        if (fx0+fy2+FD[s0+2] > th) b += 4
        if (fx1+fy2+FD[s0+3] > th) b += 32
        if (fx0+fy3+FD[s0+3] > th) b += 64
        if (fx1+fy3+FD[s0+4] > th) b += 128
        if (b == 0) { row = row " "; continue }
        hv = HX[c] + HY[r] + HG[c+r]                       # smooth hue field, ~[-3,3]
        k = int(hv*7.5 + cyco) % NC; if (k < 0) k += NC
        col = PC[k]
        # occasional bright highlight where the hue field crests (sparse, coherent)
        if (hv > 2.55 && b > 200) col = HL
        if (col != last) { row = row col; last = col }
        row = row BR[b]
      }
      out = out row
    }
    printf "%s", out "\001"
    fflush()
  }
}' <<<"$payload"; }

# dup the coproc fd: bash closes ${AWKC[0]} when the coproc exits, which would
# drop the final buffered frames
exec 3<&"${AWKC[0]}"

# start: hide cursor, disable autowrap, scroll prompt into scrollback, home
printf '\033[?25l\033[?7l'
for ((i = 0; i < lines; i++)); do printf '\n'; done
printf '\033[H'

while IFS= read -r -d $'\001' -u 3 frame; do
  printf '%s' "$frame"
  read -rsn1 -t 0.045 && finish
done
exec 3<&-

# static hold on the final banner frame (>=1.2s), skippable. Drawn, briefly
# re-drawn (so any transient stream-chunking glitch self-heals before the long
# hold), then held. finish() draws it once more and restores on the way out.
printf '%s' "$final"
read -rsn1 -t 0.06 && finish
printf '%s' "$final"
read -rsn1 -t 1.24 && finish
finish
