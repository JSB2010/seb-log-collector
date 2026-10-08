#!/bin/zsh -f
# Shared lifecycle guard. Included in generated installer / uninstaller payloads.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
typeset -r ROOT='/Library/Application Support/SOEDiagnostics' LABEL='org.soe.diagnostics.collector' PLIST='/Library/LaunchDaemons/org.soe.diagnostics.collector.plist' LOGS='/Library/Logs/SOEDiagnostics'
[[ $EUID == 0 ]] || { print -u2 'Root required'; exit 1; }
safe_path() {
  local input=$1 part current=''
  for part in ${(s:/:)input}; do [[ -z $part ]] || { current="$current/$part"; [[ ! -L $current ]] || { print -u2 'Unsafe symlink in owned path'; exit 1; }; }; done
}
for p in "$ROOT" "$PLIST" "$LOGS"; do safe_path "$p"; done
stop_job() {
  /bin/launchctl bootout "system/$LABEL" 2>/dev/null || true
  if /bin/launchctl print "system/$LABEL" >/dev/null 2>&1; then print -u2 'Collector job still loaded'; return 1; fi
  # Only processes executing our fixed project path are eligible for termination.
  local pid args seconds=0
  while (( seconds < 15 )); do
    local running=0
    for pid in ${(@f)$(/usr/bin/pgrep -f '/Library/Application Support/SOEDiagnostics/bin/(soe-diagnostics|read-source)' 2>/dev/null || true)}; do
      args=$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)
      if [[ $args == '/bin/zsh -f /Library/Application Support/SOEDiagnostics/bin/soe-diagnostics'* || $args == '/bin/zsh -f /Library/Application Support/SOEDiagnostics/bin/read-source'* ]]; then /bin/kill -TERM "$pid" 2>/dev/null || true; running=1; fi
    done
    (( running == 0 )) && return 0
    /bin/sleep 1; seconds=$((seconds+1))
  done
  print -u2 'Collector processes remain; removal stopped'; return 1
}

# Offline-safe: server revocation remains a separate IT action if unreachable.
if [[ -d $ROOT ]]; then
  for p in "$ROOT/bin" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"; do safe_path "$p"; done
  /bin/mkdir -p "$ROOT/state"; /usr/bin/touch "$ROOT/state/stopping"
  if [[ -f "$ROOT/bin/soe-diagnostics" ]]; then
    /bin/zsh -f "$ROOT/bin/soe-diagnostics" prepare-uninstall >/dev/null 2>&1 || true
  fi
fi
stop_job
for p in "$ROOT" "$PLIST" "$LOGS"; do safe_path "$p"; done
# Fixed project-owned locations only. No certificate, MDM, SEB, or user paths.
/bin/rm -rf "$ROOT" "$LOGS"
/bin/rm -f "$PLIST"
for p in "$ROOT" "$PLIST" "$LOGS"; do [[ ! -e $p && ! -L $p ]] || { print -u2 "Partial removal: $p remains"; exit 1; }; done
print 'Safe Online Exam Logs removed locally. Confirm server-side revocation in the dashboard.'
