#!/usr/bin/env bash
# Gives a headless Linux CI machine an audio output, so Chrome's AudioContext runs and the
# player's clock follows audio (without one it falls back to wall time and the sync tests fail).
set -euo pipefail
if ! command -v pulseaudio >/dev/null; then
  sudo_cmd=$(command -v sudo || true)
  $sudo_cmd apt-get update -qq
  $sudo_cmd apt-get install -y -qq pulseaudio >/dev/null
fi
pulseaudio --start --exit-idle-time=-1 --daemonize=yes
pactl load-module module-null-sink sink_name=ci >/dev/null
pactl set-default-sink ci
pactl info | grep -i 'default sink'
