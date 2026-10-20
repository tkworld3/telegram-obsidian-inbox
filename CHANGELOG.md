# Changelog

## 1.0.0 (2026-10-20)

- English UI, docs and code comments
- New `TIMEZONE` setting (defaults to the script time zone)
- New `SAVE_PHOTOS` setting (photos skipped by default, captions kept)
- AI organizer prompt with prompt-injection safeguards (`docs/ai-organizer-prompt.md`)
- MIT license

## 0.2.0 (2026-10-20)

- Photos are no longer saved; captions are kept
- Photo-only messages get a notice instead of an empty note

## 0.1.0 (2026-10-20)

- First release: polling Telegram bot on Google Apps Script
- Saves text, links, forwarded posts and files as Obsidian-ready Markdown
- Only the allowed chat is processed; secrets stay in Script Properties
