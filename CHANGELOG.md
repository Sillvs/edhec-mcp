# Changelog

All notable changes to edhec-mcp. Dates are in Europe/Paris time.

## [Unreleased]

### Coming next
- **Snack-corner pre-orders** (`resto_order_prepare`, `resto_order_confirm`): order from Claude in two steps. You see items, prices, pickup time and your balance afterwards, and nothing is booked until you confirm that exact summary. The live flow (service 202 "C&C EDHEC : Le Break", formula for €1.00, order until 10:00, pickup 11:30 to 14:00) is mapped up to the formula step; product selection and the final confirmation ship after one observed live order.

## [0.3.0] - 2026-11-02

### Added
- **Absences in Aurion:** `aurion_absence_check` lists your absences and tells you, per absence, whether an assessment was scheduled (Aurion timetable and Blackboard due dates), how much of the 48-hour proof window is left, whether a proof is on file, and what to do. It includes the attendance rules with their source.
- `aurion_absence_prepare` validates a report with your own reason and proof files and shows exactly what would be sent. `aurion_absence_submit` sends that report once, after you confirmed it. `dryRun` fills and checks the form without sending anything.

### Security
- Absence reports need a single-use confirmation that expires after 10 minutes and is refused if a proof file changed after the preview.
- The Aurion form is read back field by field (including the visible checkbox state and disabled fields) before anything is uploaded.
- Proof files are limited to pdf, jpg, jpeg and png, 10 MB, and never read from hidden or protected folders.

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
