# Security

This tool acts with a student's own EDHEC session, so security bugs matter.

**Please do not open a public issue for security problems.** Use GitHub's private
"Report a vulnerability" button on this repository instead.

In scope, for example:
- anything that could leak session cookies or local files
- writing files outside the chosen download folder
- requests leaving the EDHEC services (`learning.edhec.edu`, `aurion.edhec.edu`, `eprinting.edhec.edu`, `all-lacatho.fr`, `allresto.moneweb.fr`) or their sign-in pages
- anything that could place an order or spend money without the user's explicit confirmation
- ways for course content (prompt injection) to trigger actions the user did not ask for

Never include your cookies, the contents of `~/.edhec-mcp/` or other students' data in a report.
