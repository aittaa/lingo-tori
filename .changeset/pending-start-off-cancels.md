---
"@lingotori/extension": patch
---

fix(page-translation): turn-off requests that arrive while page translation is still starting now cancel that start, so translation no longer switches on after the user turned it off and the tab keeps its manual-off state
