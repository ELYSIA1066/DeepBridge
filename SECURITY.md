# Security Policy

Please do not report security vulnerabilities in public GitHub issues or discussions. If private vulnerability reporting is enabled for this repository, use that channel. Otherwise, contact the maintainers through an existing private channel and do not publish exploit details.

Do not commit API keys, tokens, passwords, or other credentials. The repository ignores common local environment files; keep real credentials outside the repository.

The Bridge listens on `127.0.0.1` by default and does not provide authentication. It is intended for trusted local use. Do not expose it to a LAN or the public internet without adding and reviewing an authentication and access-control layer.

The Bridge starts DeepSeek Harness as a child process, and that process inherits the Bridge environment. Run it with an environment that does not contain unrelated secrets that you do not want Harness tools to access.

The Bridge requests DSH's read-only permission mode, but this is not an operating-system sandbox or a security boundary. Use a suitably isolated, least-privilege environment when handling untrusted tasks.
