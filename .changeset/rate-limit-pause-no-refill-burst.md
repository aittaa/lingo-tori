---
"@lingotori/extension": patch
---

fix(translation): after a provider rate-limit (429) pause, resume with a single request instead of a burst, by not letting the pause refill the request token bucket
