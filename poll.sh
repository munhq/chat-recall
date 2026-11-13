#!/bin/bash
# Sample the memory of the watch unit into poll.tsv for 75 minutes, one line a minute.
# Started as a transient user unit so this script does not hold a foreground wait.
unit=chat-recall-watch
cg=/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}.service
out=/data/build/desk-work/chat-recall-oom/poll.tsv
printf 't\tpeak\tcurrent\tanon\tfile\tkernel\n' > "$out"
for i in $(seq 1 75); do
  p=$(systemctl --user show "$unit" -p MemoryPeak --value 2>/dev/null)
  c=$(systemctl --user show "$unit" -p MemoryCurrent --value 2>/dev/null)
  a=$(awk '/^anon /{printf "%d", $2/1048576}' "$cg/memory.stat" 2>/dev/null)
  f=$(awk '/^file /{printf "%d", $2/1048576}' "$cg/memory.stat" 2>/dev/null)
  k=$(awk '/^kernel /{printf "%d", $2/1048576}' "$cg/memory.stat" 2>/dev/null)
  printf '%s\t%d\t%d\t%s\t%s\t%s\n' "$(date -u +%H:%M)" "$((p/1048576))" "$((c/1048576))" "$a" "$f" "$k" >> "$out"
  sleep 60
done
