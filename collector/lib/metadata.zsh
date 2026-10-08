metadata() {
  local f=$1 p sebv='' sebb='' console
  json_new "$f"; json_string "$f" collectorVersion "$VERSION"; json_int "$f" managementProtocol 1; json_string "$f" architecture "$(/usr/bin/uname -m)"; json_string "$f" macOSVersion "$(/usr/bin/sw_vers -productVersion)"; json_string "$f" macOSBuild "$(/usr/bin/sw_vers -buildVersion)"; json_string "$f" reportedAt "$(utc)"
  json_string "$f" timezone "$(/usr/bin/readlink /etc/localtime | /usr/bin/sed 's|.*/zoneinfo/||')"
  p='/Applications/Safe Exam Browser.app/Contents/Info.plist'
  if [[ -f $p ]]; then sebv=$(json_value "$p" CFBundleShortVersionString); sebb=$(json_value "$p" CFBundleVersion); json_string "$f" sebVersion "$sebv"; json_string "$f" sebBuild "$sebb"; json_string "$f" sebPath '/Applications/Safe Exam Browser.app'; else /usr/bin/plutil -insert sebVersion -json null "$f"; fi
  console=$(/usr/bin/stat -f '%Su' /dev/console); json_string "$f" consoleUser "$console"
  for p in HostName LocalHostName ComputerName; do local k="${p[1,1]:l}${p[2,-1]}"; json_string "$f" "$k" "$(/usr/sbin/scutil --get "$p" 2>/dev/null || true)"; done
  /usr/bin/plutil -convert json "$f"
}
