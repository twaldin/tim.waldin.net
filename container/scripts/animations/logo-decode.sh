#!/usr/bin/env bash
# logo-decode.sh — scramble-decode intro: the banner area boils as dense
# block/glyph noise, then decodes left-to-right behind an eased (smoothstep)
# wavefront; each char flashes bright white as it locks. The noise field is
# mostly green with occasional cyan and rare bright-white sparkle cells.
#
# v3 end-contract: NEVER clears the screen (no \033[2J). Banner text comes from
# ${BOOT_BANNER_FILE:-/tmp/boot-banner.txt} (plain text, 3–11 lines tall,
# width ≤ cols-2) with a figlet DOS_Rebel fallback; height/width are derived
# at runtime and the decode grid maps onto them. At start the shell prompt is
# scrolled up into scrollback (LINES newlines), then we animate in place with
# cursor addressing. On natural end OR any keypress we draw the COMPLETE final
# frame (banner ONLY — no tagline) pinned to the TOP of the screen (first line
# on row 1), park the cursor EXACTLY one row below the last banner line,
# restore SGR/autowrap/cursor, and exit — so the final frame persists on
# screen and in scrollback while welcome.sh prints below.
#
# mawk is byte-based (even under UTF-8 locales), so a loader pass normalizes
# the banner to ONE byte per display cell: ASCII passes through, each
# multibyte glyph becomes a single high-byte token with a @MAP table
# (token → glyph bytes) for rendering. All frames are precomputed in one awk
# pass. Each emitted write is capped at a byte budget WELL under the PTY's
# 1024-byte read chunk, so no frame is ever split mid-escape by the recorder.
# Oversized frames are emitted as sub-frames (mode 's') played ~12ms apart.
# Modes: n=banner frame, s=sub-frame, F=final-frame chunk, P=cursor park row.
set -u

cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
rows=${LINES:-$(tput lines 2>/dev/null || echo 24)}

BF=32   # banner decode frames

# --- v3 banner input ---------------------------------------------------------
banner_file=${BOOT_BANNER_FILE:-/tmp/boot-banner.txt}
banner=
[ -s "$banner_file" ] && banner=$(cat "$banner_file")
[ -z "$banner" ] && banner=$(figlet -f DOS_Rebel -w 400 twaldin 2>/dev/null)
[ -z "$banner" ] && banner=twaldin

# normalize: one byte per display cell; trims leading/trailing blank lines and
# trailing whitespace. Emits normalized banner lines, then "@MAP <token-byte>
# <glyph byte>..." lines, then "@END".
normalize() {
  awk '
    BEGIN { for (i = 1; i < 256; i++) ORD[sprintf("%c", i)] = i; nt = 0 }
    { gsub(/\r/, ""); gsub(/\t/, " "); L[NR] = $0 }
    END {
      a = 1; b = NR;                            # trim leading/trailing blanks
      while (a <= b && L[a] ~ /^[ ]*$/) a++;
      while (b >= a && L[b] ~ /^[ ]*$/) b--;
      for (r = a; r <= b; r++) {
        line = L[r]; n = length(line);
        while (n > 0 && substr(line, n, 1) == " ") n--;   # rstrip
        out = ""; i = 1;
        while (i <= n) {
          v = ORD[substr(line, i, 1)];
          if (v >= 194) {                       # UTF-8 lead byte: whole char
            g = substr(line, i, 1); i++;
            while (i <= n) { v = ORD[substr(line, i, 1)]; if (v < 128 || v >= 192) break; g = g substr(line, i, 1); i++ }
            if (!(g in TOK)) { nt++; TOK[g] = sprintf("%c", 127 + nt); MAP[nt] = g }
            out = out TOK[g];
          } else {
            out = out substr(line, i, 1); i++;
          }
        }
        print out;
      }
      for (k = 1; k <= nt; k++) {
        g = MAP[k]; bytes = "";
        for (j = 1; j <= length(g); j++) bytes = bytes " " ORD[substr(g, j, 1)];
        printf "@MAP %d%s\n", 127 + k, bytes;
      }
      print "@END";
    }' <<< "$1"
}
norm=$(normalize "$banner")
[[ $norm == *'@END'* ]] || norm=$(normalize twaldin)

frames=()
mapfile -t frames < <(awk -v cols="$cols" -v lines="$rows" -v seed="$RANDOM" \
                          -v BF="$BF" '
# emit one cell into the current write buffer; flush a sub-frame first if adding
# this cell could push the buffer past BUDGET (breaking only between cells).
function put(row, scol, col, g, gb) {
  if (blen > 0 && blen + 24 > BUDGET) { printf "%s%s\n", (fmode ? "F" : "s"), out; out=""; blen=0; last=""; curr=-1; curc=-1 }
  if (scol != curc || row != curr) { out = out sprintf("\033[%d;%dH", row, scol); blen += 9 }
  if (col != last) { out = out "\033[0;" col "m"; blen += length(col) + 5; last = col }
  out = out g; blen += gb
  curr = row; curc = scol + 1
}
function newframe() { out=""; blen=0; last=""; curr=-1; curc=-1 }
# noise-cell color: ~85% green (dim..bright), occasional cyan, rare white sparkle
function pickcol(  x) {
  x = rand()
  if (x < 0.045) return "1;97"                       # rare bright-white sparkle
  if (x < 0.19)  return (rand() < 0.75 ? "96" : "36")# occasional cool silver-cyan accent
  x = rand()                                         # green body, leans mid/bright
  if (x < 0.30) return "2;32"
  if (x < 0.62) return "32"
  if (x < 0.85) return "2;92"
  return "92"
}
# resolve a normalized cell byte to its display glyph + byte length
function glyphof(ch, g) {
  if (ch == " ") { g = " "; GB_ = 1 }
  else if (ch in GLYPH) { g = GLYPH[ch]; GB_ = GB[ch] }
  else { g = ch; GB_ = 1 }
  return g
}
/^@MAP / {
  split($0, A, " "); tok = sprintf("%c", A[2] + 0); g = ""
  for (j = 3; j <= length(A); j++) g = g sprintf("%c", A[j] + 0)
  GLYPH[tok] = g; GB[tok] = length(A) - 2; next
}
/^@END$/ { next }
{ bn++; B[bn] = $0; if (length($0) > W) W = length($0) }
END {
  srand(seed)
  BUDGET = 900; FL = 2
  R = bn
  for (r = 1; r <= R; r++) while (length(B[r]) < W) B[r] = B[r] " "

  left = int((cols - W) / 2) + 1;  if (left < 1) left = 1
  top  = 1                                            # v3: pinned to TOP (row 1)

  # per-cell lock frame: eased (smoothstep) wavefront + per-cell jitter
  J = 7
  for (r = 1; r <= R; r++)
    for (c = 1; c <= W; c++) {
      p = (c - 1 + rand() * J) * W / (W + J); lk = BF - FL
      for (f = 1; f <= BF; f++) { t = f / BF; if (W * t * t * (3 - 2 * t) >= p) { lk = f; break } }
      if (lk > BF - FL) lk = BF - FL
      LK[r "," c] = lk
    }

  nb = split("H ░ ▒ ▓ █ ▚ ▞", BLK, " ")                                  # 3-byte glyphs
  na = split("# % * + = / \\ | < > ? $ & @ 0 1 x ^ ~ :", ASC, " ")       # 1-byte glyphs (no ; to keep leak-scan clean)

  # ---- banner decode frames ----
  for (f = 1; f <= BF; f++) {
    newframe()
    for (r = 1; r <= R; r++) {
      for (c = 1; c <= W; c++) {
        scol = left + c - 1; if (scol > cols) break
        lk = LK[r "," c]
        if (f > lk + FL) continue                      # locked & settled: skip (redrawn only in final frame)
        g = glyphof(substr(B[r], c, 1)); gb = GB_
        if (f < lk) {                                  # pre-lock noise
          if (last == "" || last == "1;97" || rand() < 0.14) col = pickcol()
          if (rand() < 0.18) { g = BLK[int(rand() * nb) + 1]; gb = 3 } else { g = ASC[int(rand() * na) + 1]; gb = 1 }
          if (g == "H") g = "░"                        # BLK[1] token → real glyph
        } else if (f < lk + FL) {                      # lock flash
          col = "1;97"
        } else {                                       # just settled
          col = (g == "░" ? "2;32" : "92")
        }
        put(top + r - 1, scol, col, g, gb)
      }
    }
    printf "n%s\n", out
  }

  # ---- final clean redraw: whole banner in FINAL slot colors ----
  # fmode=1 → put() flushes oversized chunks with prefix "F" so bash can replay
  # the COMPLETE final frame on skip/finish (not just the last chunk).
  fmode = 1
  newframe()
  for (r = 1; r <= R; r++)
    for (c = 1; c <= W; c++) {
      scol = left + c - 1; if (scol > cols) break
      g = glyphof(substr(B[r], c, 1)); gb = GB_
      col = (g == "░" ? "2;32" : "92")
      put(top + r - 1, scol, col, g, gb)
    }
  printf "F%s\n", out
  # emit the below-block row so bash can park the cursor there after the frame
  printf "P%d\n", top + R
}' <<<"$norm")

n=${#frames[@]}
# split emitted lines: F* = final-frame chunks (complete), P = below-block row,
# everything else = decode animation frames.
anim=()
finalchunks=()
belowrow=""
for ((i = 0; i < n; i++)); do
  line=${frames[i]}
  case ${line:0:1} in
    F) finalchunks+=("${line:1}") ;;
    P) belowrow=${line:1} ;;
    *) anim+=("$line") ;;
  esac
done
if [ -z "$belowrow" ] || [ "$belowrow" -gt "$rows" ] 2>/dev/null; then belowrow=$rows; fi

draw_final() {                            # draw the COMPLETE final frame
  local ch
  for ch in "${finalchunks[@]}"; do printf '%s' "$ch"; done
}
finish() {
  draw_final                              # complete banner, clean
  printf '\033[%d;1H' "$belowrow"         # park cursor exactly one row below the banner
  printf '\033[0m\033[?7h\033[?25h'       # restore SGR, autowrap, cursor — NO 2J
  exit 0
}
trap 'finish' INT TERM

# start: hide cursor, disable autowrap, scroll prompt into scrollback, home
printf '\033[?25l\033[?7l'
for ((i = 0; i < rows; i++)); do printf '\n'; done
printf '\033[H'

# play the decode animation
na=${#anim[@]}
for ((i = 0; i < na; i++)); do
  line=${anim[i]}
  mode=${line:0:1}
  printf '%s' "${line:1}"
  case $mode in
    s) d=0.012 ;;
    *) d=0.033 ;;
  esac
  read -rsn1 -t "$d" && finish
done

# draw the complete final frame, then static hold (>=1.2s), skippable
draw_final
read -rsn1 -t 1.3 && finish
finish
