# Security reporting

Use this repository's **Security → Report a vulnerability** feature for suspected credential exposure, authorization bypass, unsafe privileged filesystem access or malicious upload handling. If private reporting is unavailable on a fork, contact that fork's operator privately. Do not include secrets, enrollment scripts, student log contents or real device identifiers in a public issue.

Provide the affected version, a synthetic reproduction, expected/observed behavior and scope. Security fixes target the latest stable release; 0.x releases are historical previews. Operators should test and deploy the latest patched server/collector to their authorized scope.

The collector uses root for coordination, reads only documented Safe Exam Browser logs, and preserves macOS privacy controls. Source logs are user-controlled diagnostic material. The limits and access/retention model are documented in [acceptance](docs/acceptance.md) and the README.
