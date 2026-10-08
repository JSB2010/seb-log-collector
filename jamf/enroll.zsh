#!/bin/zsh -f
# Prefer the restricted one-time script downloaded from the enrollment dashboard.
# Alternatively send the bootstrap code to this script over stdin as root.
set -eu
/bin/zsh -f '/Library/Application Support/SOEDiagnostics/bin/soe-diagnostics' enroll --bootstrap-stdin
