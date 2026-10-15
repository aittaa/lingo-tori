---
"@lingotori/extension": patch
---

fix(translation): a page translation that came back with a formula placeholder dropped, duplicated or invented is still shown but is no longer remembered by the tab, so translating the same paragraph again asks the provider again instead of reusing the damaged result
