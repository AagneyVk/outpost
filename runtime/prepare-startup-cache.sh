#!/bin/sh
set -eu
profile=/tmp/public-profile
output=/tmp/public-startup-cache
mkdir -p /tmp/outpost-runtime "$profile" "$output"
chmod 700 /tmp/outpost-runtime
export DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/outpost-runtime
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -noreset -extension GLX >/tmp/xvfb.log 2>&1 &
sleep 1
printf '<!doctype html><title>OUTPOST Cache Seed</title><p>Public build fixture</p>' >/tmp/cache-fixture.html
dbus-run-session -- firefox-esr --no-remote --profile "$profile" file:///tmp/cache-fixture.html >/tmp/firefox.log 2>&1 &
browser_pid=$!
i=0
until xwininfo -root -tree 2>/dev/null | grep -Eq '\("Navigator" "firefox-esr"\)  [1-9][0-9]{2,}x[1-9][0-9]{2,}'; do
 sleep 1
 i=$((i+1))
 [ "$i" -lt 60 ] || { cat /tmp/firefox.log; exit 1; }
done
sleep 20
pkill -TERM -u 1000 -x firefox-esr
wait "$browser_pid" || true
# Only build compatibility metadata and Mozilla's internal compiled code caches.
cp "$profile/compatibility.ini" "$output/"
for name in startupCache.4.little scriptCache.bin scriptCache-child.bin; do
 if [ -s "$profile/startupCache/$name" ]; then
  cp "$profile/startupCache/$name" "$output/"
 fi
done
test -s "$output/startupCache.4.little"
ls -l "$output"
firefox-esr --version
