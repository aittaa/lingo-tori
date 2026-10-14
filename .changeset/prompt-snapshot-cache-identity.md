---
"@lingotori/extension": patch
---

fix(translation): run each queued page and subtitle translation with the prompt its cache key was hashed over, so switching prompts mid-translation no longer caches one prompt's output under another's key
