#!/usr/bin/env bash
# braille-fire.sh — DOOM fire rendered in braille sub-cells (2x4 px per char).
# A 1D-heat-array fire burns at the bottom of the screen in a 256-color
# deep-red -> orange -> yellow -> white FORGE gradient while the twaldin banner
# is hammered out above the flames: dim -> red-hot -> orange -> yellow ->
# quenched brand green. awk (mawk) streams frames; bash paces them and polls
# for a skip keypress. Pure bash 5.2 + coreutils + awk.
#
# END-CONTRACT v3: this is the FIRST thing the visitor's shell runs. The banner
# text comes from ${BOOT_BANNER_FILE:-/tmp/boot-banner.txt} (plain-text figlet
# lines, 3-11 rows tall, width <= COLUMNS-2) so the font can vary per boot;
# height/width are derived from the file at runtime. We scroll the prompt up
# into scrollback (NO \033[2J anywhere), animate in place, and on finish we
# leave the QUENCHED-GREEN BANNER pinned to the TOP of the screen (first line
# on row 1, fire fully wiped) with the cursor parked EXACTLY one row below the
# last banner line so welcome.sh prints directly beneath. A keypress jumps
# straight to that identical final frame.
set -u

# bash substring/${#} must be glyph-aware (figlet banners are UTF-8); mawk is
# locale-insensitive, so this is safe for the awk stage below.
export LC_ALL=C.UTF-8

cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
lines=${LINES:-$(tput lines 2>/dev/null || echo 24)}

FR=13                                   # fire height in char rows (taller = bigger flames)
(( lines <= 22 )) && FR=$(( lines / 2 ))
(( FR < 4 )) && FR=4
(( FR > lines - 10 )) && FR=$(( lines - 10 ))
(( FR < 4 )) && FR=4

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

AWKPID=
kill_awk() { [[ -n ${AWKPID:-} ]] && kill "$AWKPID" 2>/dev/null; AWKPID=; }
# restore modes ONLY — never clears the screen (final frame must persist).
show_restore() { printf '\033[0m\033[?25h\033[?7h'; }

E=$'\033'
banner_top=1                            # v3: banner pinned to the TOP of the screen
pad=$(( (cols - bw) / 2 )); (( pad < 0 )) && pad=0
below_row=$(( banner_top + bh ))        # EXACTLY one row below the last banner line
(( below_row > lines )) && below_row=$lines

draw_banner() { # $1 = SGR params (e.g. "1;32")
  local sgr=$1 out='' i
  for i in "${!banner[@]}"; do
    out+="${E}[$(( banner_top + i ));$(( pad + 1 ))H${banner[i]}${E}[K"
  done
  printf '%s[%sm%s%s[0m' "$E" "$sgr" "$out" "$E"
}

# Final persistent frame: quenched-green banner ONLY, pinned to the top rows.
# Every fire/ember remnant below the banner is wiped with \033[0J (erase-to-
# end-of-DISPLAY, which leaves scrollback untouched — this is NOT \033[2J).
# The cursor ends parked EXACTLY one row below the last banner line so
# welcome.sh prints there.
final_frame() {
  draw_banner '1;32'
  printf '%s[%d;1H%s[0J' "$E" "$below_row" "$E"
}

F=40 FADE=27

printf '\033[?25l\033[?7l'
# Scroll the live prompt up into scrollback, then animate from home in place.
for ((i=0;i<lines;i++)); do printf '\n'; done
printf '\033[H'

trap 'kill_awk; final_frame; show_restore; exit 0' INT TERM

exec 3< <(awk -v COLS="$cols" -v LINES="$lines" -v FR="$FR" -v F="$F" -v FADE="$FADE" '
BEGIN{
  srand()
  E=sprintf("%c",27)
  W=COLS*2; H=FR*4; T=2
  np=split("16 52 52 52 88 88 88 124 124 124 160 160 160 196 196 196 202 202 202 208 208 208 214 214 214 220 220 220 226 226 226 228 228 228 230 230 231", pal, " ")
  for(n=0;n<256;n++) BR[n]=sprintf("%c%c%c",226,160+int(n/64),128+n%64)
  for(i=0;i<W*H;i++) heat[i]=0
  for(f=0;f<F;f++){
    # --- source row: ignite from center, RAGE hot+wide, then cut fuel to fade.
    #     S peaks well above the 36-colour cap so cooling still leaves tall,
    #     dense, saturated flames that lick right up toward the banner. ---
    if(f<7){ S=int(42*(f+1)/7); halfw=int(W*(f+1)/8) }
    else if(f<FADE){ S=42; halfw=W }
    else { fr=(F-f)/(F-FADE); if(fr<0)fr=0; S=int(42*fr); halfw=W }
    mid=int(W/2)
    for(x=0;x<W;x++){
      d=x-mid; if(d<0)d=-d
      if(S>0 && d<=halfw){ v=S-int(rand()*5); if(v<0)v=0; heat[x]=v }
      else heat[x]=0
    }
    # --- propagate upward. Because each row is fed from the freshly-updated
    #     row below, the flame height tracks the source: RAGE keeps S high for
    #     tall hot flames; FADE ramps S down so the fire visibly SHRINKS/recedes
    #     frame by frame instead of blinking out in one step. ---
    dmax=3; dof=0
    if(f>=FADE){ dmax=4; dof=0 }
    for(y=1;y<H;y++){
      b=y*W; a=b-W
      for(x=0;x<W;x++){
        s=heat[a+x]
        if(s<=0){ heat[b+x]=0; continue }
        v=s-int(rand()*dmax)-dof; if(v<0)v=0
        nx=x+int(rand()*3)-1; if(nx<0)nx=0; else if(nx>=W)nx=W-1
        heat[b+nx]=v
      }
    }
    # --- render: pack 2x4 pixels per braille char, color by max heat ---
    last=-1; out=""
    for(cb=FR-1;cb>=0;cb--){
      yb=cb*4
      o0=yb*W; o1=o0+W; o2=o1+W; o3=o2+W
      row=E "[" (LINES-cb) ";1H"
      for(cx=0;cx<COLS;cx++){
        px=cx*2; qx=px+1
        m=0; n=0
        h=heat[o3+px]; if(h>=T)n+=1;  if(h>m)m=h
        h=heat[o2+px]; if(h>=T)n+=2;  if(h>m)m=h
        h=heat[o1+px]; if(h>=T)n+=4;  if(h>m)m=h
        h=heat[o0+px]; if(h>=T)n+=64; if(h>m)m=h
        h=heat[o3+qx]; if(h>=T)n+=8;  if(h>m)m=h
        h=heat[o2+qx]; if(h>=T)n+=16; if(h>m)m=h
        h=heat[o1+qx]; if(h>=T)n+=32; if(h>m)m=h
        h=heat[o0+qx]; if(h>=T)n+=128;if(h>m)m=h
        if(n==0) row=row " "
        else{
          if(m>36)m=36
          c=pal[m+1]
          if(c!=last){ row=row E "[38;5;" c "m"; last=c }
          row=row BR[n]
        }
      }
      out=out row
    }
    # one write per frame: bash reads the whole \n-terminated line and prints
    # it in a single printf, so escapes never straddle a write boundary
    printf "%s\n", out; fflush()
  }
}')
AWKPID=$!

skipped=0
f=0
while IFS= read -r -u3 frame; do
  printf '%s' "$frame"
  # banner forge arc: dim -> red-hot -> orange -> bright yellow -> quenched green.
  # Redrawn every frame so any transient stream-chunking glitch self-heals.
  if   (( f >= 32 )); then draw_banner '1;32'
  elif (( f >= 25 )); then draw_banner '93'
  elif (( f >= 19 )); then draw_banner '33'
  elif (( f >= 12 )); then draw_banner '31'
  elif (( f >=  5 )); then draw_banner '90'
  fi
  if read -rsn1 -t 0.05; then skipped=1; break; fi
  f=$(( f + 1 ))
done
exec 3<&-
kill_awk

# END: draw the clean quenched-green banner (fire fully wiped) and hold it.
final_frame
if (( skipped == 0 )); then
  read -rsn1 -t 1.3     # static banner hold (>=1.2s); a keypress ends it early
fi
show_restore
exit 0
