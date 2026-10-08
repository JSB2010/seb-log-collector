#!/bin/zsh -f
# Root-only maintenance dispatcher. Launchers use sudo; Jamf already runs as root.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset CDPATH ENV BASH_ENV
typeset -r ROOT='/Library/Application Support/SOEDiagnostics'
[[ $EUID == 0 ]] || { print -u2 'Root required'; exit 1; }
for owned in "$ROOT" "$ROOT/support" "$ROOT/config.json" "$ROOT/state"; do
  [[ -e $owned && ! -L $owned ]] || { print -u2 'Installation missing or unsafe'; exit 1; }
done
check_script() {
  local file=$1 checksum=$2
  [[ -f $file && ! -L $file && -f $checksum && ! -L $checksum ]] || return 1
  [[ $(/usr/bin/shasum -a 256 < "$file" | /usr/bin/awk '{print $1}') == $(<"$checksum") ]] || { print -u2 'Script checksum mismatch'; return 1; }
  /bin/zsh -n "$file"
}
case ${1:-status} in
  collect) /bin/zsh -f "$ROOT/bin/soe-diagnostics" collect --now; /bin/zsh -f "$ROOT/support/manage.zsh" status ;;
  pause|resume) /bin/zsh -f "$ROOT/bin/soe-diagnostics" "$1" ;;
  status)
    file=$(/usr/bin/mktemp "$ROOT/state/command-status.XXXXXXXX")
    trap '/bin/rm -f "$file"' EXIT
    /bin/zsh -f "$ROOT/bin/soe-diagnostics" status --json > "$file"
    print 'Safe Online Exam Logs'
    for field label in collectorVersion Version outcome Status enrolled Enrolled locallyPaused Paused lastContact 'Last contact' lastError 'Last error'; do
      value=$(/usr/bin/plutil -extract "$field" raw -o - "$file" 2>/dev/null || true)
      [[ -z $value ]] || print -r -- "$label: ${value//_/ }"
    done ;;
  reinstall|uninstall)
    action=$1; file="$ROOT/support/installer.zsh"; [[ $action != uninstall ]] || file="$ROOT/support/uninstall.zsh"
    check_script "$file" "$file.sha256"
    /bin/zsh -f "$file" ;;
  update)
    origin=$(/usr/bin/plutil -extract apiOrigin raw -o - "$ROOT/config.json")
    [[ $origin == https://* && $origin != *[$'\n\r\t "\\']* && ${origin#https://} != */* && ${origin#https://} != *[@?#]* ]] || { print -u2 'Invalid update origin'; exit 1; }
    work=$(/usr/bin/mktemp -d "$ROOT/state/update.XXXXXXXX")
    trap '/bin/rm -rf "$work"' EXIT
    /usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --max-filesize 262144 --output "$work/manifest.json" "$origin/collector/manifest.json"
    version=$(/usr/bin/plutil -extract version raw -o - "$work/manifest.json")
    expected=$(/usr/bin/plutil -extract installer.sha256 raw -o - "$work/manifest.json")
    installer_path=$(/usr/bin/plutil -extract installer.path raw -o - "$work/manifest.json")
    [[ $version == <->.<->.<-> && ${#version} -le 30 && $expected == [a-f0-9]## && ${#expected} == 64 && $installer_path == /collector/install.zsh ]] || { print -u2 'Invalid update manifest'; exit 1; }
    installed=$(<"$ROOT/state/installed-version")
    [[ $installed == <->.<->.<-> ]] || { print -u2 'Installed version is unavailable'; exit 1; }
    old=(${(s:.:)installed}); new=(${(s:.:)version}); newer=0
    for i in 1 2 3; do
      if (( 10#${new[$i]} > 10#${old[$i]} )); then newer=1; break
      elif (( 10#${new[$i]} < 10#${old[$i]} )); then print -u2 'Server release is older; refusing downgrade'; exit 1; fi
    done
    (( newer )) || { print -r -- "Already up to date ($installed)"; exit 0; }
    /usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 --max-filesize 2097152 --output "$work/install.zsh" "$origin$installer_path"
    actual=$(/usr/bin/shasum -a 256 < "$work/install.zsh" | /usr/bin/awk '{print $1}')
    [[ $actual == $expected ]] || { print -u2 'Update checksum mismatch; existing installation preserved'; exit 1; }
    /bin/zsh -n "$work/install.zsh"
    print -r -- "Updating Safe Online Exam Logs from $installed to $version"
    /bin/zsh -f "$work/install.zsh" ;;
  *) print -u2 'Commands: collect, status, pause, resume, update, reinstall, uninstall'; exit 2 ;;
esac
