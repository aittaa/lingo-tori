---
"@lingotori/extension": patch
---

fix(popup): the translate button and the context menu title now change only after a page in the tab has received the toggle; when none can be reached (a tab opened before the install, or before an extension update or reload) the popup keeps its state and asks the user to refresh the page, the popup stops waiting for an unanswered toggle after five seconds, and a late acknowledgement can no longer overwrite the menu title of a newer tab or state
