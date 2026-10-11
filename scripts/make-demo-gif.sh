#!/usr/bin/env bash
# Regenerate the hero demo GIF (assets/demo.gif) from a fresh, deterministic
# recording of the real extension running a task.
#
# Requires: ffmpeg, ffprobe and python3 on PATH, and a browser for Playwright. On a headless server,
# this script runs the capture under xvfb automatically if xvfb-run is present.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN="node test/demo.mjs"
if command -v xvfb-run >/dev/null 2>&1 && [ -z "${DISPLAY:-}" ]; then
  RUN="xvfb-run -a --server-args=-screen 0 1500x900x24 $RUN"
fi

echo "Recording the panel…"
$RUN                                   # writes assets/demo-raw/panel.webm

VID=assets/demo-raw/panel.webm
PAL="$(mktemp --suffix=.png)"
echo "Encoding GIF…"
# demo.mjs writes, in the panel video's clock, when the task was sent
# (assets/demo-raw/sent-at.txt) and when the answer had finished in the DOM
# (settled-at.txt), plus a screenshot of the finished panel (final.png). The
# screencast and the script clocks drift by a few hundred ms either way, and
# the screencast sometimes never delivers the last paint, so:
#  - the GIF starts 0.8 s before the send time: a beat on the empty panel,
#    long after the recorder has finished refining the freshly painted panel
#    (those first frames each cost a full redraw);
#  - it ends on final.png, held for 2.5 s. The video is used up to the first
#    frame (searched from 1.5 s before the settle time) that already matches
#    final.png (PSNR >= 38 dB), or up to its end if no frame ever does.
SENT=$(cat assets/demo-raw/sent-at.txt)
SETTLED=$(cat assets/demo-raw/settled-at.txt)
FINAL=assets/demo-raw/final.png
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VID")
START=$(python3 -c "print(f'{max(float(\"$SENT\") - 0.8, 0.0):.2f}')")
psnr_vs_final() { # $1 = time; prints the PSNR (dB) of that video frame against final.png
  ffmpeg -hide_banner -nostats -ss "$1" -i "$VID" -i "$FINAL" -lavfi "[0:v][1:v]psnr" -frames:v 1 -f null - 2>&1 \
    | grep -oE "average:(inf|[0-9.]+)" | cut -d: -f2 || true
}
CUT=""
for t in $(python3 -c "
d=float('$DUR'); t=max(float('$SETTLED')-1.5, 0.0)
while t <= d-0.05: print(f'{t:.2f}'); t+=0.1"); do
  v=$(psnr_vs_final "$t")
  if python3 -c "import sys; v='$v'; sys.exit(0 if v=='inf' or (v and float(v) >= 38) else 1)"; then CUT=$t; break; fi
done
if [ -z "$CUT" ]; then
  CUT=$DUR
  echo "note: no recorded frame matches the finished panel; using the whole recording, then the screenshot"
fi
if ! python3 -c "import sys; sys.exit(0 if float('$CUT') > float('$START') + 1.0 else 1)"; then
  echo "cut at ${CUT}s is too close to the start at ${START}s — the recording looks wrong; run again" >&2
  exit 1
fi
echo "GIF: recording ${START}s to ${CUT}s of ${DUR}s (sent ${SENT}s, settled ${SETTLED}s), then final.png for 2.5 s"
# mpdecimate drops frames that only differ by encoder noise (the recorder keeps
# refining a static picture for a while after each repaint), fps=15 then
# repeats the kept frame exactly, which costs nothing in a GIF. No dithering:
# the flat panel UI does not need it, and it would turn noise into palette
# flips. The palette is built from every frame (stats_mode=full), not from
# frame differences, so static accents such as the green status dots keep a
# slot; 128 colours are plenty for the flat UI and keep noise flips cheap.
SCALE="fps=15,scale=460:-1:flags=lanczos,format=rgb24,setsar=1"
GRAPH="[0:v]trim=start=$START:end=$CUT,setpts=PTS-STARTPTS,mpdecimate,$SCALE[v0];[1:v]$SCALE[v1];[v0][v1]concat=n=2:v=1:a=0[v]"
ffmpeg -y -i "$VID" -loop 1 -framerate 15 -t 2.5 -i "$FINAL" -lavfi "$GRAPH;[v]palettegen=stats_mode=full:max_colors=128" "$PAL"
ffmpeg -y -i "$VID" -loop 1 -framerate 15 -t 2.5 -i "$FINAL" -i "$PAL" -lavfi "$GRAPH;[v][2:v]paletteuse=dither=none" assets/demo.gif
rm -f "$PAL"
echo "Wrote assets/demo.gif"
