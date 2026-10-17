import { z } from "zod"

/**
 * The optional categories a request may declare on the wire (a stream payload, an internal ChatGPT
 * invocation). Only the page URL is declared: authenticationInfo follows from the credentials the
 * request actually carries, never from what a caller says. A declaration only ever adds checks.
 */
export const dataCategoriesSchema = z
  .array(z.enum(["browsingActivity"]))
  .max(4)
  .optional()
