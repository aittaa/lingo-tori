---
"@lingotori/extension": patch
---

fix(popup): the translate button now stops waiting for a toggle answer when it is unmounted, so a late acknowledgement can no longer change the translated state or send a request after the button is gone
