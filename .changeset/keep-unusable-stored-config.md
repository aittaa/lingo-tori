---
"@lingotori/extension": patch
---

fix(config): stop replacing a stored config that cannot be used with the defaults; startup, the hourly backup, restore, import and reset now keep an exact copy of it, never back up the defaults as the user's settings, and exporting current settings is refused instead of exporting the defaults
