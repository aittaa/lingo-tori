import { describe, expect, it } from "vitest"
import {
  ConfigConflictError,
  ConfigOutcomeUnknownError,
  ConfigRecoveryRequiredError,
  ConfigRefusedError,
  ConfigUnavailableError,
  ConfigVersionTooNewError,
  PreservationError,
} from "../errors"
import { KeptCopyRestoreError } from "../recovery-actions"
import { describeRecoveryFailure } from "../recovery-failure"

// Only the kind of a failure is read from it, never its text: whatever the message of an error says
// (a validation error quotes the value it rejected), it does not reach the screen.
describe("describeRecoveryFailure", () => {
  it.each([
    { error: new KeptCopyRestoreError("gone"), kind: "gone" },
    { error: new KeptCopyRestoreError("unreadable"), kind: "unreadable" },
    { error: new KeptCopyRestoreError("invalid"), kind: "invalid" },
    { error: new ConfigVersionTooNewError("newer"), kind: "newer-version" },
    { error: new PreservationError("full"), kind: "no-room" },
    { error: new PreservationError("write-failed"), kind: "not-kept" },
    { error: new PreservationError("verify-failed"), kind: "not-kept" },
    { error: new PreservationError("unrepresentable"), kind: "not-kept" },
    { error: new ConfigUnavailableError(), kind: "unavailable" },
    { error: new ConfigOutcomeUnknownError(), kind: "unavailable" },
    { error: new ConfigConflictError(), kind: "unavailable" },
    { error: new ConfigRefusedError("field-not-allowed-for-sender"), kind: "other" },
    { error: new ConfigRecoveryRequiredError("invalid-schema"), kind: "other" },
    { error: new Error('Invalid provider id "sk-synthetic-sentinel-0000".'), kind: "other" },
    { error: "not even an error", kind: "other" },
    { error: undefined, kind: "other" },
  ])("names $kind for $error", ({ error, kind }) => {
    expect(describeRecoveryFailure(error)).toBe(kind)
  })

  it("does not read the kind of a restore failure from its message", () => {
    const error = new KeptCopyRestoreError("gone")
    error.message = "an invalid provider id"

    expect(describeRecoveryFailure(error)).toBe("gone")
  })
})
