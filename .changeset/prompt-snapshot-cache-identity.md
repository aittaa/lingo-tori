---
"@lingotori/extension": patch
---

fix(translation): run each queued page and subtitle translation with the prompt its cache key was hashed over, so switching prompts mid-translation no longer caches one prompt's output under another's key, and keep requests from an older content script that carry no prompt snapshot out of the shared queue identity and the translation cache, and never fold a request that carries no cache hash into a different one, so it always receives its own translation
