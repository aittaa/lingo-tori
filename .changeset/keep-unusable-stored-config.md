---
"@lingotori/extension": patch
---

fix(config): stop replacing a stored config that cannot be used with the defaults; startup leaves it in place and keeps a copy of it when storage allows, the hourly backup skips it, edits, restore, import and reset are refused instead of overwriting it, exporting current settings is refused instead of exporting the defaults, and the settings page and the error screen can save the stored settings exactly as they are, after a warning that the file holds credentials (replacing such a config from the settings page arrives in a later update)
