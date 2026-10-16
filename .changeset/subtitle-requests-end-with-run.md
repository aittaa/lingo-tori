---
"@lingotori/extension": patch
---

fix(subtitles): end a subtitle run's queued and in-flight translation requests when it is turned off, its video changes or its tab closes, so a stopped run no longer keeps spending provider quota while a request another tab still wants keeps going
