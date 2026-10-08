#!/bin/zsh -f
# Called only with an isolated synthetic fixture by cloud-smoke.mjs.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
typeset ROOT=${NATIVE_FIXTURE_ROOT:?} API_ORIGIN=${TEST_ORIGIN:?}
[[ $EUID != 0 && $ROOT == */.local/collector-test ]] || exit 2
typeset STATE="$ROOT/state" STAGE="$ROOT/staging/native space" CREDS="$ROOT/credentials/native-test-device.json"
typeset project=${0:A:h:h}
source "$project/collector/lib/common.zsh"
source "$project/collector/lib/http.zsh"
API_ORIGIN=$TEST_ORIGIN
WORK=$(/usr/bin/mktemp -d "$STATE/native-cloud.XXXXXXXX")
trap '/bin/rm -rf "$WORK"; /bin/rm -f "$CREDS" "$STATE/native-bootstrap" "$STATE/native-enrollment.json" "$STATE/native-policy.json" "$STAGE"/*.gz(N)' EXIT
bootstrap_http "$(<"$STATE/native-bootstrap")" "$STATE/native-enrollment.json"
[[ -n $(json_value "$HTTP_RESPONSE" deviceId) ]]
http GET /api/device/v1/config
[[ $(json_value "$HTTP_RESPONSE" paused) == false ]]
typeset policy="$STATE/native-policy.json" upload_id=$(json_value "$STATE/native-policy.json" uploadId)
typeset staged=("$STAGE"/*.gz(N))
[[ ${#staged} == 1 ]]
post_gcs "$policy" "$staged[1]"
[[ $HTTP_CODE == 201 ]]
http POST "/api/device/v1/uploads/$upload_id/complete" '{}'
[[ $(json_value "$HTTP_RESPONSE" state) == accepted ]]
print 'Native macOS cloud check passed: curl-config enrollment, JSON response parsing, device authentication, literal multipart POST with a space in the staged path, and accepted completion.'
