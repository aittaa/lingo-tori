---
"@lingotori/extension": minor
---

feat(firefox): declare what the add-on sends and ask Firefox for consent before credentialed requests

The Firefox build now declares the page, selected and subtitle text it sends to your provider as required data, and offers two optional permissions, which stay off until you allow them, instead of claiming that nothing is transmitted. Authentication info is needed when a request carries an API key, a credential header, credentials in the endpoint URL or the ChatGPT sign-in; browsing activity is needed when a custom action uses the page URL. Grant them with the new buttons in the provider, ChatGPT and custom action settings. Without the permission the request is not sent and a message says what to allow; the permission is checked again right before each request is sent, including retries, so switching it off in about:addons stops the next request that has not been sent yet. Keyless custom endpoints keep working, and a new per-provider setting lets you declare a secret that is hidden in an endpoint URL. Signing out always clears the local ChatGPT tokens and skips the remote revocation without consent. Prompt tokens are now expanded in a single pass, so page text that looks like a token such as the page-URL token is sent as the text it is. Chrome is unchanged.
