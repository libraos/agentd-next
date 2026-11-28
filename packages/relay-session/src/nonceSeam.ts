// Test seam, deliberately left out of package.json "exports": reaching NONCE_LIMIT honestly takes
// 2^31 messages, so tests start new transport ciphers near it instead. Production never sets it.
let transportNonceStart = 0;

export const getTransportNonceStart = (): number => transportNonceStart;

export const setTransportNonceStart = (nonce: number): void => {
  transportNonceStart = nonce;
};
