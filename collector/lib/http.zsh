curl_value() { local s=$1; [[ $s != *[$'\n\r\t']* ]] || return 1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; print -rn -- "$s"; }
curl_option() { print -r -- "$2 = \"$(curl_value "$3")\"" >> "$1"; }
http() {
  local method=$1 route=$2 body=${3:-} max=${4:-45} token cfg="$WORK/http.curl" out="$WORK/response.json" bodyfile="$WORK/body.json"
  [[ $route == /api/device/v1/* && $route != *[$'\n\r "\\']* ]] || return 1
  token="$(json_value "$CREDS" installationId).$(json_value "$CREDS" secret)"
  [[ $token == [0-9a-f-]##.[A-Za-z0-9_-]## ]] || return 1
  : > "$cfg"; curl_option "$cfg" url "$API_ORIGIN$route"; curl_option "$cfg" header "Authorization: Bearer $token"; curl_option "$cfg" header 'Content-Type: application/json'; curl_option "$cfg" request "$method"; curl_option "$cfg" output "$out"
  if [[ -n $body ]]; then print -rn -- "$body" > "$bodyfile"; curl_option "$cfg" data-binary "@$bodyfile"; fi
  HTTP_CODE=$(/usr/bin/curl -q --config "$cfg" --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time "$max" --max-filesize 262144 --write-out '%{http_code}' 2>/dev/null) || { HTTP_CODE=000; return 1; }
  HTTP_RESPONSE=$out
  [[ $HTTP_CODE == 2<-> ]] || return 1
  [[ $method == POST && $route == */deactivate ]] && return 0
  /usr/bin/plutil -lint "$out" >/dev/null 2>&1 || return 1
}
bootstrap_http() {
  local bootstrap=$1 cfg="$WORK/bootstrap.curl" bodyfile=$2 out="$WORK/enrollment-response.json"
  : > "$cfg"; curl_option "$cfg" url "$API_ORIGIN/api/device/v1/enroll"; curl_option "$cfg" header "Authorization: Bearer $bootstrap"; curl_option "$cfg" header 'Content-Type: application/json'; curl_option "$cfg" request POST; curl_option "$cfg" data-binary "@$bodyfile"; curl_option "$cfg" output "$out"
  HTTP_CODE=$(/usr/bin/curl -q --config "$cfg" --silent --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 45 --max-filesize 262144 --write-out '%{http_code}' 2>/dev/null) || return 1
  HTTP_RESPONSE=$out; [[ $HTTP_CODE == 2<-> ]] && /usr/bin/plutil -lint "$out" >/dev/null
}
post_gcs() {
  local policy=$1 gzipfile=$2 cfg="$WORK/gcs.curl" url key value field count
  url=$(json_value "$policy" url)
  [[ $url == https://storage.googleapis.com/[a-z0-9._-]## && $gzipfile == "$STAGE/"[a-f0-9]##.gz && -f $gzipfile && ! -L $gzipfile ]] || return 1
  : > "$cfg"; curl_option "$cfg" url "$url"; curl_option "$cfg" output "$WORK/gcs-response"
  # Fixed approved keys; form-string keeps every value literal, even leading @.
  for key in key Content-Type success_action_status x-goog-algorithm x-goog-credential x-goog-date x-goog-meta-upload-id policy x-goog-signature; do
    value=$(json_value "$policy" "fields.$key") || return 1
    curl_option "$cfg" form-string "$key=$value"
  done
  curl_option "$cfg" form "file=@$gzipfile;type=application/gzip"
  HTTP_CODE=$(/usr/bin/curl -q --config "$cfg" --silent --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 90 --write-out '%{http_code}' 2>/dev/null) || return 1
  [[ $HTTP_CODE == 2<-> ]]
}
