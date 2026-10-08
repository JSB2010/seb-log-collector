# Only two typed commands are supported. No server-provided shell is executed.
management_result() {
  local result="$STATE/management-result.json" id
  [[ -f $result && ! -L $result ]] || return 0
  id=$(json_value "$result" id) || return 1
  [[ $id == [a-f0-9-]## && ${#id} == 36 ]] || return 1
  if http POST "/api/device/v1/commands/$id/ack" "$(json_value "$result" body)" 15; then /bin/rm -f "$result"; fi
}
management_command() {
  local configfile=$1 id action active="$STATE/management-active" work label version expected route
  id=$(json_value "$configfile" commands.0.id 2>/dev/null) || return 1
  [[ $id == [a-f0-9-]## && ${#id} == 36 ]] || return 1
  action=$(json_value "$configfile" commands.0.action)
  [[ $action == update || $action == uninstall ]] || return 1
  if seb_running; then http POST "/api/device/v1/commands/$id/ack" '{"state":"deferred","result":"busy"}' 15 || true; set_outcome deferred; return 0; fi
  label="org.soe.diagnostics.management.$id"
  if /bin/launchctl print "system/$label" >/dev/null 2>&1; then set_outcome management_running; return 0; fi
  if [[ -f $active && ! -L $active ]]; then
    local prior=$(<"$active")
    [[ $prior == [a-f0-9-]## && ${#prior} == 36 ]] || return 1
    if /bin/launchctl print "system/org.soe.diagnostics.management.$prior" >/dev/null 2>&1; then set_outcome management_running; return 0; fi
  fi
  work=$(/usr/bin/mktemp -d /private/var/tmp/SafeOnlineExamLogs-management.XXXXXXXX) || return 1
  /bin/chmod 700 "$work"
  for f in management-worker.zsh uninstall.zsh; do
    [[ -f "$ROOT/support/$f" && ! -L "$ROOT/support/$f" && -f "$ROOT/support/$f.sha256" && ! -L "$ROOT/support/$f.sha256" ]] || { /bin/rm -rf "$work"; return 1; }
    [[ $(hash_file "$ROOT/support/$f") == $(<"$ROOT/support/$f.sha256") ]] || { /bin/rm -rf "$work"; return 1; }
    /bin/cp "$ROOT/support/$f" "$work/$f"
  done
  /bin/cp "$CREDS" "$work/device.json"
  json_new "$work/command.json"; json_string "$work/command.json" id "$id"; json_string "$work/command.json" action "$action"; json_string "$work/command.json" origin "$API_ORIGIN"
  if [[ $action == update ]]; then
    version=$(json_value "$configfile" commands.0.version); expected=$(json_value "$configfile" commands.0.sha256); route=$(json_value "$configfile" commands.0.path)
    [[ $version == <->.<->.<-> && ${#version} -le 30 && $expected == [a-f0-9]## && ${#expected} == 64 && $route == "/collector/releases/$version/install.zsh" ]] || { /bin/rm -rf "$work"; return 1; }
    json_string "$work/command.json" version "$version"; json_string "$work/command.json" sha256 "$expected"; json_string "$work/command.json" path "$route"
  fi
  /bin/cat > "$work/worker.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>$label</string><key>ProgramArguments</key><array><string>/bin/zsh</string><string>-f</string><string>$work/management-worker.zsh</string><string>$work</string></array><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>10</integer></dict></plist>
PLIST
  /bin/chmod 600 "$work"/*
  print -r -- "$id" > "$active"
  if ! /bin/launchctl bootstrap system "$work/worker.plist"; then /bin/rm -rf "$work"; /bin/rm -f "$active"; return 1; fi
  set_outcome management_running
  return 0
}
