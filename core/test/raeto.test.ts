// Raeto's answers (raeto.ts): the images an image model returns, as OpenAI-compatible answers carry them (choices[]
// message.images[] image_url.url, data: URLs), decoded to their bytes; an answer without images has none.

import assert from "node:assert/strict";
import { test } from "node:test";
import { raetoImages } from "../src/raeto.ts";

// A 1x1 PNG (its signature, IHDR, IDAT and IEND chunks).
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");

test("an answer's images are decoded from their data: URLs, in order, with their media types", () => {
  const url = `data:image/png;base64,${PNG.toString("base64")}`;
  const answer = { choices: [{ message: { content: "here", images: [{ type: "image_url", image_url: { url } }, { type: "image_url", image_url: { url: "https://not.inline/x.png" } }] } }, { message: { images: [{ image_url: { url } }] } }] };
  const got = raetoImages(answer);
  assert.deepEqual(got.map((x) => [x.index, x.mediaType, Buffer.from(x.bytes).equals(PNG)]), [[0, "image/png", true], [2, "image/png", true]]);
});

test("an answer without images, or not an answer, has none", () => {
  assert.deepEqual(raetoImages({ choices: [{ message: { content: "text only" } }] }), []);
  assert.deepEqual(raetoImages(null), []);
  assert.deepEqual(raetoImages({ error: "x" }), []);
});
