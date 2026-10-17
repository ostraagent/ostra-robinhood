// Text encodings the payment protocols use, without Node's Buffer.

const decoder = new TextDecoder();

/** Decodes base64url (RFC 4648 section 5, padding optional); throws on anything else. */
export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error("invalid base64url string");
  const bare = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (bare.length % 4 === 1) throw new Error("invalid base64url string");
  const binary = atob(bare.padEnd(bare.length + ((4 - (bare.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** UTF-8 bytes as text (an invalid sequence becomes U+FFFD). */
export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
