---
"@lingotori/extension": patch
---

fix(translation): when several tabs share a batched translation, give its retries and per-item fallbacks only the tabs that still want it, so cancelling one tab no longer aborts a request another tab is waiting for, and cancelling the last one stops it
