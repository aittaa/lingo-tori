---
"@lingotori/extension": patch
---

fix(config): stop replacing a stored config that cannot be used with the defaults; startup leaves it in place and keeps a copy of it when storage allows, the hourly backup skips it, edits and Back up now are refused instead of overwriting it, restore, import and reset keep an exact, confirmed copy of it before they replace it, exporting current settings is refused instead of exporting the defaults, and the settings page and the error screen can save the stored settings exactly as they are, after a warning that the file holds credentials
