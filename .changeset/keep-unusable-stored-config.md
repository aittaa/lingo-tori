---
"@lingotori/extension": patch
---

fix(config): stop replacing a stored config that cannot be used with the defaults; startup keeps an exact copy of it and leaves it in place, the hourly backup skips it, edits, restore, import and reset are refused instead of overwriting it, and exporting current settings is refused instead of exporting the defaults (replacing such a config from the settings page arrives in a later update)
