import { sendByosMessage } from "@/utils/byos/messages"

// No credential-store imports, remote resources, HTML injection or outgoing links.
const query = location.search
history.replaceState(null, "", location.pathname)
const status = document.getElementById("status")
void sendByosMessage("lingotoriByosCallback", query).then(
  () => {
    if (status)
      status.textContent =
        "Sign-in completed. Return to API Providers settings to refresh the connection."
  },
  () => {
    if (status)
      status.textContent =
        "Sign-in could not be completed. Return to API Providers settings and try again."
  },
)
