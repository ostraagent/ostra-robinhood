// A decision's reason file (pad.ts): kept by digest as what it is, whatever job names it (reasonFromBytes,
// reasonFromFile), and shown by a decision only when it is that decision's own (reasonState). Files are built as core
// builds them (sdk padReasonFile), then with one thing wrong each.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "viem";
import { PAD_ENC_KIND, padEncryptFile, padNewJobKey, padNewSalt, padPlaintextPrefix, padReasonFile } from "@ostraagent/sdk";
import { reasonFromBytes, reasonFromFile, reasonState } from "../src/pad.ts";

const job: Hex = "0x03fc86bc00000000000000000000000000000000000000000000000000002ead";
const other: Hex = "0x21d0c4d300000000000000000000000000000000000000000000000000000001";
const digest: Hex = `0x${"ab".repeat(32)}`;
const bytes = (f: unknown) => new TextEncoder().encode(JSON.stringify(f));

test("a reason file core writes is kept with its own job, approve and text", () => {
  const text = "The delivery answers none of the seven questions.\nIt only echoes the input.";
  const kept = reasonFromBytes(bytes(padReasonFile(job, false, text)));
  assert.deepEqual(kept, { kind: "public", job, approve: false, reason: text });
  assert.equal(reasonFromFile({ ...padReasonFile(job, false, text), job: job.toUpperCase().replace("0X", "0x") }).kind, "public");
});

test("a decision shows a file only when it is that decision's own", () => {
  const kept = reasonFromBytes(bytes(padReasonFile(job, true, "Approved: every field is there.")));
  assert.equal(reasonState(kept, digest, job, true), "public");
  assert.equal(reasonState(kept, digest, other, true), "invalid", "another job's decision naming this file");
  assert.equal(reasonState(kept, digest, job, false), "invalid", "the other verdict");
  assert.equal(reasonState(undefined, digest, job, true), "unread");
  assert.equal(reasonState(undefined, null, job, true), "none");
  assert.equal(reasonState({ kind: "sealed" }, digest, job, true), "private");
  assert.equal(reasonState({ kind: "invalid", why: "x" }, digest, job, true), "invalid");
});

test("an encrypted reason file is sealed; other bytes, and JSON that is not a decision file, are invalid", () => {
  // As the evaluator bot seals a private job's reason (keeper pad-private.ts sealReason), under a fresh job key.
  const prefix = padPlaintextPrefix({ type: "ostrapad-decision-v1", job, approve: false, reason: "Rejected." });
  const sealed = padEncryptFile(padNewJobKey(), { kind: PAD_ENC_KIND.reason, salt: padNewSalt(), plaintextLength: prefix.length, order: null }, prefix);
  assert.deepEqual(reasonFromBytes(sealed), { kind: "sealed" });
  const notReason = { kind: "invalid", why: "neither a decision file nor an encrypted reason" };
  assert.deepEqual(reasonFromBytes(sealed.subarray(0, sealed.length - 1)), notReason, "cut short");
  const delivery = padEncryptFile(padNewJobKey(), { kind: PAD_ENC_KIND.delivery, salt: padNewSalt(), plaintextLength: prefix.length, order: null }, prefix);
  assert.deepEqual(reasonFromBytes(delivery), notReason, "an encrypted delivery");
  assert.deepEqual(reasonFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])), notReason, "a PNG's first bytes");
  assert.deepEqual(reasonFromBytes(new Uint8Array([0xff, 0xfe, 0x7b])), notReason);
  const good = padReasonFile(job, true, "Approved: every field is there.");
  const cases: [unknown, string][] = [
    [null, "not a JSON object"],
    [[good], "not a JSON object"],
    ["text", "not a JSON object"],
    [{ ...good, type: "ostrapad-delivery-v1" }, "not an ostrapad-decision-v1 file"],
    [{ ...good, job: "0x1234" }, "no job id"],
    [{ ...good, approve: "yes" }, "no approve"],
    [{ ...good, reason: 5 }, "no reason text"],
    [{ ...good, reason: "   " }, "a reason of 0 characters"],
    [{ ...good, reason: "x".repeat(4_001) }, "a reason of 4001 characters"],
    [{ ...good, reason: "bell\u0007" }, "control or bidirectional characters"],
    [{ ...good, reason: "c1 \u0085 control" }, "control or bidirectional characters"],
    [{ ...good, reason: "approved ‮devorppa" }, "control or bidirectional characters"],
    [{ ...good, reason: "isolate ⁧x⁩" }, "control or bidirectional characters"],
  ];
  for (const [file, why] of cases) assert.deepEqual(reasonFromFile(file), { kind: "invalid", why });
  assert.equal(reasonFromFile({ ...good, reason: "x".repeat(4_000) }).kind, "public");
  assert.equal(reasonFromFile({ ...good, reason: "Lines\n\tand tabs stay." }).kind, "public");
});
