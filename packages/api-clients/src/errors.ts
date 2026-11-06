/**
 * Errors thrown when a vendor API answered with a non-2xx HTTP status.
 *
 * The message is unchanged from the plain `Error` these clients threw
 * before (e.g. "Quo API error: 500 - ..."), so existing message checks keep
 * working. The extra `status` lets callers tell a definitive vendor answer
 * (the request reached the vendor and was rejected) from a transport
 * failure (network error, timeout, abort), where the request may or may
 * not have gone through.
 */
export class VendorHttpError extends Error {
  readonly vendor: string;
  readonly status: number;

  constructor(vendor: string, status: number, message: string) {
    super(message);
    this.name = 'VendorHttpError';
    this.vendor = vendor;
    this.status = status;
  }
}

/**
 * True when `err` is a vendor HTTP error response (4xx/5xx). Structural, so
 * it also matches across duplicated module copies in a bundle.
 */
export function isVendorHttpError(err: unknown): err is VendorHttpError {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  return (
    err.name === 'VendorHttpError' &&
    typeof status === 'number' &&
    status >= 400 &&
    status <= 599
  );
}
