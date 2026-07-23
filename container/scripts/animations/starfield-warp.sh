#!/usr/bin/env bash
# starfield-warp.sh — hyperspace starfield intro. Braille-dot stars stream
# outward from center (accelerating warp) in a rich multi-hued field, ignite
# green mid-flight, then decelerate and converge to forge the banner with an
# arrival flash, holding it bold-bright. Any keypress skips straight to the
# final banner. Pure bash 5.2 + awk (mawk).
#
# v3 end-contract: banner text comes from ${BOOT_BANNER_FILE:-/tmp/boot-
# banner.txt} (plain text, 3–11 lines tall, width ≤ cols-2) with a figlet
# DOS_Rebel fallback; height/width are derived at runtime, and the converge
# targets map onto that runtime mask. We scroll the prompt into scrollback,
# animate in place with cursor addressing (never \033[2J), and leave the final
# banner pinned to the TOP of the screen (first line on row 1) with the cursor
# parked EXACTLY one row below the last banner line, so the theme-strobe
# finale + welcome.sh can continue underneath.
set -u

cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
lines=${LINES:-$(tput lines 2>/dev/null || echo 24)}

# minimal signal-path cleanup — no screen clear, keep scrollback intact
restore() { printf '\033[0m\033[?25h\033[?7h'; }
trap 'restore; exit 0' INT TERM

# --- v3 banner input -------------------------------------------------------
# Read ${BOOT_BANNER_FILE:-/tmp/boot-banner.txt}; fall back to figlet. mawk is
# byte-based (even under UTF-8 locales), so the loader normalizes the banner
# to a mask of exactly ONE byte per display cell: every multibyte glyph and
# every non-space ASCII char becomes '#', spaces stay spaces. Mask line
# length == display width afterwards.
banner_file=${BOOT_BANNER_FILE:-/tmp/boot-banner.txt}
banner=
[ -s "$banner_file" ] && banner=$(cat "$banner_file")
[ -z "$banner" ] && banner=$(figlet -f DOS_Rebel -w 400 twaldin 2>/dev/null)
[ -z "$banner" ] && banner=twaldin
load_mask() {
  awk '
    BEGIN { for (i = 1; i < 256; i++) ORD[sprintf("%c", i)] = i }
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
            out = out "#"; i++;
            while (i <= n) { v = ORD[substr(line, i, 1)]; if (v < 128 || v >= 192) break; i++ }
          } else {
            out = out (v == 32 ? " " : "#"); i++;
          }
        }
        print out;
      }
    }' <<< "$1"
}
mask=$(load_mask "$banner")
[[ $mask == *'#'* ]] || mask=$(load_mask twaldin)

out=$(awk -v cols="$cols" -v rows="$lines" -v M="$mask" '
function plot(x, y, co,   ix, iy, ck, b, r) {
  ix = int(x); iy = int(y);
  if (ix < 0 || iy < 0 || ix >= SW || iy >= SH) return;
  ck = int(iy/4) * cols + int(ix/2);
  b = BB[ix%2, iy%4];
  if (!((ck, b) in SEEN)) { SEEN[ck, b] = 1; BITS[ck] += b; }
  r = RANK[co];
  if (!(ck in CRK) || r > CRK[ck]) { CRK[ck] = r; COLR[ck] = co; }
}
function emit(   ck, bits, cy, cx, o) {
  o = "\033[H";
  for (cy = 0; cy < rows; cy++) o = o sprintf("\033[%d;1H\033[2K", cy+1);
  for (ck in BITS) {
    bits = BITS[ck]; cy = int(ck/cols); cx = ck % cols;
    o = o sprintf("\033[%d;%dH\033[%sm%c%c%c", cy+1, cx+1, COLR[ck], \
                  226, 160 + int(bits/64), 128 + bits%64);
  }
  o = o "\033[0m";
  print o;
  delete BITS; delete SEEN; delete COLR; delete CRK;
}
BEGIN {
  SW = cols*2; SH = rows*4;
  BB[0,0]=1; BB[0,1]=2; BB[0,2]=4; BB[0,3]=64;
  BB[1,0]=8; BB[1,1]=16; BB[1,2]=32; BB[1,3]=128;
  # brightness rank — brighter colour wins when two stars share a sub-cell
  RANK["90"]=0; RANK["37"]=1; RANK["95"]=2; RANK["94"]=3;
  RANK["93"]=4; RANK["92"]=5; RANK["97"]=6; RANK["1;92"]=7; RANK["1;97"]=8;

  # --- banner targets ---------------------------------------------------
  nm = split(M, MR, "\n"); MW = 0;
  for (r = 1; r <= nm; r++) if (length(MR[r]) > MW) MW = length(MR[r]);
  sx = 2; sy = 4;                          # each # = one full braille cell
  if (SW < 2*MW + 2) { sx = 1; sy = 2; }   # tiny terminals: half-width
  offx = int((SW - sx*MW)/2); offx -= offx % 2;    # align to braille cell
  offy = 0;                                # v3: banner pinned to TOP (row 1)
  N = 0;
  for (r = 1; r <= nm; r++) {
    L = MR[r];
    for (c = 1; c <= length(L); c++) if (substr(L, c, 1) == "#")
      for (dx = 0; dx < sx; dx++) for (dy = 0; dy < sy; dy++) {
        N++; TX[N] = offx + sx*(c-1) + dx; TY[N] = offy + sy*(r-1) + dy;
      }
  }
  # cursor row directly below the banner block (1-based), for the caller
  belowrow = int((offy + sy*nm - 1)/4) + 2;
  if (belowrow > rows) belowrow = rows;
  print "META " belowrow;

  # --- stars --------------------------------------------------------------
  CX = SW/2; CY = SH/2;
  RMAX = sqrt(CX*CX + CY*CY) + 6;
  srand(7);
  for (i = 1; i <= N; i++) {
    a = rand()*6.2831853;
    CA[i] = cos(a); SA[i] = sin(a);
    S[i] = 0.45 + rand()*1.25;      # per-star speed scale
    R0[i] = rand()*RMAX;            # starting radius
    p = rand();                     # rich multi-hued field (few gray)
    if      (p < 0.05) CO[i] = "95";   # magenta/purple (rare)
    else if (p < 0.18) CO[i] = "93";   # amber-yellow
    else if (p < 0.33) CO[i] = "92";   # lime green
    else if (p < 0.52) CO[i] = "94";   # vivid cyan (Hardcore brightBlue)
    else if (p < 0.70) CO[i] = "37";   # soft white
    else               CO[i] = "97";   # bright white
    IG[i] = 0.40 + rand()*0.52;        # per-star green-ignition threshold
  }

  F1 = 22; F2 = 16; F3 = 5;         # warp / converge / arrival frames

  # --- phase 1: accelerating warp + mid-flight green ignition -------------
  V0 = 14; K = 130;                 # travel D(t)=V0*t+K*t^3, speed v=V0+3K*t^2
  for (f = 0; f < F1; f++) {
    t = f/(F1-1);
    D = V0*t + K*t*t*t;
    v = (V0 + 3*K*t*t)/(F1-1);      # per-frame speed (streak length)
    for (i = 1; i <= N; i++) {
      r = R0[i] + S[i]*D; r -= int(r/RMAX)*RMAX;
      x = CX + r*CA[i]; y = CY + r*SA[i];
      lit = (t >= IG[i]);            # latched: once ignited, stays green
      co = lit ? "1;92" : CO[i];
      if (r < 10) co = "90";                       # dim near the core
      plot(x, y, co);
      sl = S[i]*v;                                 # streak trail toward center
      if (sl > 1.6) {
        seg = 0;
        for (k = 1.4; k < sl && k < 10; k += 1.4) {
          rr = r - k; if (rr < 2) break;
          # trail inherits a dim echo of the head: green when ignited
          plot(CX + rr*CA[i], CY + rr*SA[i], \
               seg == 0 ? (lit ? "92" : "37") : "90");
          seg++;
        }
      }
      if (f == F1-1) { LX[i] = x; LY[i] = y; }     # capture for convergence
    }
    emit();
  }

  # --- phase 2: decelerate + converge onto banner (green streaks) ---------
  for (f = 1; f <= F2; f++) {
    u = f/F2; e = 1 - (1-u)*(1-u)*(1-u);           # ease-out (decelerating)
    co = (u > 0.94) ? "1;97" : "1;92";             # green streaks, whiten only as they lock
    for (i = 1; i <= N; i++)
      plot(LX[i] + (TX[i]-LX[i])*e, LY[i] + (TY[i]-LY[i])*e, co);
    emit();
  }

  # --- phase 3: crisp white arrival flash, settle to bold brand green ------
  for (f = 0; f < F3; f++) {
    for (i = 1; i <= N; i++) {
      co = "1;92";                                 # bold bright brand green
      if (f == 0) co = "1;97";                      # arrival flash (bold white)
      else if (f == 1) co = "97";                   # flash decay
      else if (rand() < 0.02) co = "1;97";          # occasional sparkle glint
      plot(TX[i], TY[i], co);
    }
    emit();
  }
}' <<< "$mask")

mapfile -t F <<< "$out"
meta=(${F[0]})
belowrow=${meta[1]:-$lines}
nf=${#F[@]}                          # F[0]=META, F[1..nf-1]=frames

# --- v2 start: hide cursor, no autowrap, scroll prompt into scrollback ----
printf '\033[?25l\033[?7l'
for ((n = 0; n < lines; n++)); do printf '\n'; done
printf '\033[H'

# Wall-clock schedule (µs): read-timeout shrinks if a frame ran long, so total
# duration holds steady even on a loaded host. Input polled every frame.
dt_us=55000
start=${EPOCHREALTIME/./}
i=0
skip=0
for ((idx = 1; idx < nf; idx++)); do
  printf '%s' "${F[idx]}"
  i=$((i+1))
  rem=$(( start + i*dt_us - ${EPOCHREALTIME/./} ))
  (( rem < 1000 )) && rem=1000
  read -rsn1 -t "$((rem/1000000)).$(printf '%06d' "$((rem%1000000))")" && { skip=1; break; }
done

# Final frame: always the fully-settled banner. On skip we jump straight to it;
# on natural finish it is already on screen, so we hold it statically >=1.2s.
if (( skip )); then
  printf '%s' "${F[nf-1]}"
else
  read -rsn1 -t 1.3
fi

# Persist: cursor to the row below the banner, reset, show cursor, restore
# autowrap. No \033[2J — scrollback (prompt, banner, then welcome) survives.
printf '\033[%d;1H\033[0m\033[?25h\033[?7h' "$belowrow"
exit 0
