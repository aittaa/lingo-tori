---
"@lingotori/extension": patch
---

fix(selection): run selection translation and custom actions on the provider configuration they were built from, so editing a provider while a request is on its way can no longer pair its new endpoint, key and model with the old temperature and options
