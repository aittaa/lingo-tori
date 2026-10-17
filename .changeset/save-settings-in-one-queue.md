---
"@lingotori/extension": patch
---

fix(config): save every settings change through one queue in the background, so changes made at the same time from the settings pages, the popup and the page controls no longer overwrite each other, a change whose answer is lost is not saved twice, and a restore that fails leaves the backups as they were
