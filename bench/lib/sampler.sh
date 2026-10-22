#!/usr/bin/env bash
# Sample container CPU/mem about once a second into a TSV: time, name, cpu%, mem.
#   lib/sampler.sh OUT.tsv container...   (runs until killed; containers not running are skipped)
out=$1; shift
while true; do
  running=$(for c in "$@"; do docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -q true && echo "$c"; done)
  [ -n "$running" ] && docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $running 2>/dev/null | sed "s/^/$(date +%H:%M:%S)\t/" >> "$out"
  sleep 0.5
done
