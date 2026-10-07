// workerd extension to Web Crypto: a constant-time compare of two equal-length buffers.
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
}
