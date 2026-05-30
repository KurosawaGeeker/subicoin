export class StoreError extends Error {
  constructor(
    readonly code: "conflict" | "insufficient_credits" | "invalid" | "not_found" | "unauthorized",
    message: string,
  ) {
    super(message);
  }
}

export const errConflict = (message = "conflict") => new StoreError("conflict", message);
export const errInsufficientCredits = (message = "insufficient credits") => new StoreError("insufficient_credits", message);
export const errInvalid = (message = "invalid input") => new StoreError("invalid", message);
export const errNotFound = (message = "not found") => new StoreError("not_found", message);
export const errUnauthorized = (message = "unauthorized") => new StoreError("unauthorized", message);

export function isStoreError(error: unknown, code?: StoreError["code"]): error is StoreError {
  return error instanceof StoreError && (code === undefined || error.code === code);
}
