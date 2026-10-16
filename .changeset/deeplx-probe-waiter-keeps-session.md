---
"@lingotori/extension": patch
---

fix(page-translation): cancel a translation-only request that waited on the DeepLX capability probe, or on its own first answer before a retry, when its page-translation session has stopped, instead of sending it unscoped or into a newer session
