const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getRuntimeBuffer(): typeof Buffer | undefined {
  const maybeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  return maybeBuffer;
}

export function bytesFromUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8FromBytes(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function encodeBase64FromBytes(value: Uint8Array): string {
  const runtimeBuffer = getRuntimeBuffer();
  if (runtimeBuffer) {
    return runtimeBuffer.from(value).toString('base64');
  }

  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeBase64ToBytes(value: string): Uint8Array {
  const runtimeBuffer = getRuntimeBuffer();
  if (runtimeBuffer) {
    return new Uint8Array(runtimeBuffer.from(value, 'base64'));
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toBufferLike(value: Uint8Array): Buffer {
  const runtimeBuffer = getRuntimeBuffer();
  if (runtimeBuffer) {
    return runtimeBuffer.from(value);
  }
  return value as unknown as Buffer;
}
