import { expect, test } from "bun:test";

import {
    beginRuntimeConnectAttempt,
    cancelRuntimeConnectAttempt,
    finishRuntimeConnectAttempt,
} from "../../src/store/slices/connection-runtime-connect-attempts";

test("disconnect makes a late initial connect result stale", () => {
    const attempt = beginRuntimeConnectAttempt("profile-disconnect-race");

    cancelRuntimeConnectAttempt("profile-disconnect-race");

    expect(
        finishRuntimeConnectAttempt("profile-disconnect-race", attempt),
    ).toBe(false);
});

test("a newer connect attempt prevents an older result from changing session state", () => {
    const first = beginRuntimeConnectAttempt("profile-newer-connect");
    const second = beginRuntimeConnectAttempt("profile-newer-connect");

    expect(finishRuntimeConnectAttempt("profile-newer-connect", first)).toBe(
        false,
    );
    expect(finishRuntimeConnectAttempt("profile-newer-connect", second)).toBe(
        true,
    );
});
