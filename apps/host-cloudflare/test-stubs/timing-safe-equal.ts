import { timingSafeEqual } from "node:crypto";

// `crypto.subtle.timingSafeEqual` is a workerd extension; Node's WebCrypto lacks it.
const subtle: { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean } =
  crypto.subtle;
subtle.timingSafeEqual ??= timingSafeEqual;
