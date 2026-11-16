#!/bin/bash
# 軽量化プロファイル第2弾: B (現行・フル解像度 scdet) と C (480幅に縮小して scdet) の比較
F12=$(ls /mnt/truenas-recordings/*相棒*.m2ts)
echo "file: $F12"
timed() {
  local tag="$1"; shift
  local s
  s=$(date +%s)
  "$@" >/dev/null 2>&1
  echo "$tag: $(( $(date +%s) - s ))s"
}
timed B-fullres-scdet ffmpeg -hide_banner -nostats -v error -i "$F12" -an -sn -dn -fps_mode passthrough -vf 'scdet=threshold=100,metadata=mode=print:key=lavfi.scd.score:file=/tmp/prof-cuts-b' -f null - -map 0:a:0 -af 'silencedetect=noise=0.00152587890625:d=0.15,ametadata=mode=print:file=/tmp/prof-sil-b' -f null -
timed C-scale480-scdet ffmpeg -hide_banner -nostats -v error -i "$F12" -an -sn -dn -fps_mode passthrough -vf 'scale=480:-2,scdet=threshold=100,metadata=mode=print:key=lavfi.scd.score:file=/tmp/prof-cuts-c' -f null - -map 0:a:0 -af 'silencedetect=noise=0.00152587890625:d=0.15,ametadata=mode=print:file=/tmp/prof-sil-c' -f null -
python3 /tmp/profcmp.py
echo PROFILE2_DONE
