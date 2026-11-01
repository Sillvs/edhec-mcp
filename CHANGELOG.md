# Changelog

All notable changes to edhec-mcp. Dates are in Europe/Paris time.

## [Unreleased]

### Coming next
- **Snack-corner pre-orders** (`resto_order_prepare`, `resto_order_confirm`): order from Claude in two steps. You see items, prices, pickup time and your balance afterwards, and nothing is booked until you confirm that exact summary. Ships after a live test of the morning ordering window.

## [0.2.0] - 2026-11-01

### Added
- **Aurion:** `aurion_timetable` gives your classes with room, teacher and type for any date range. `aurion_view` reads grades, resits, absences, proofs of absence, registrations, groups, free rooms and the academic calendar. `aurion_certificate` saves your school certificate as a PDF.
- **Campus food:** `resto_menu` shows today's menu as images Claude can read. `resto_balance` and `resto_history` show your campus card balance and purchases. `resto_services` lists what you can book on MONEWEB.
- Results can now include images (used for menus).

### Security
- Every result and error is scrubbed of cookies, tokens, browser call logs, badge and student numbers.
- Downloads refuse hidden, config and system folders, never overwrite files and skip programs and scripts.
- File names from EDHEC systems are cleaned for `..`, Windows reserved names, right-to-left tricks and over-long unicode.
- Folder checks ignore letter case on macOS and Windows.
- Lookups only accept exact allowed values (no `__proto__` tricks).

## [0.1.0] - 2026-11-01

### Added
- **Blackboard Learn:** list courses, read content and announcements, download all course files, grades and due dates, upcoming deadlines, read-only API access.
- **PaperCut ePrinting:** print A4, A3 or stapled, see your print quota and held jobs, cancel a job.
- One-time sign-in with your own EDHEC Microsoft account (`npm run login` or `edhec_login`).
