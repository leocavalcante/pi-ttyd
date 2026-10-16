import assert from "node:assert/strict";
import test from "node:test";
import register from "../index.js";

function withEnvironment(value, callback) {
  const previous = process.env.PI_TTYD_NOTIFY;
  if (value === undefined) delete process.env.PI_TTYD_NOTIFY;
  else process.env.PI_TTYD_NOTIFY = value;

  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env.PI_TTYD_NOTIFY;
    else process.env.PI_TTYD_NOTIFY = previous;
  }
}

test("does not register notifications unless enabled", () => {
  withEnvironment(undefined, () => {
    const registrations = [];
    register({ on: (...args) => registrations.push(args) });
    assert.deepEqual(registrations, []);
  });
});

test("emits a title marker after the agent settles", () => {
  withEnvironment("1", () => {
    const registrations = [];
    const output = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      output.push(String(chunk));
      return true;
    };

    try {
      register({ on: (...args) => registrations.push(args) });
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0][0], "agent_settled");

      registrations[0][1]();
      assert.match(output[0], /^\x1b\]2;__PI_TTYD__:\d+:\d+:\d+\x07$/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
