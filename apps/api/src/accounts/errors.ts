import { IdentityLinksError } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";

/** Do not send raw SQL errors, including credential bind values, to the logger. */
export async function accountRepositoryCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    if (error instanceof IdentityLinksError) {
      const kind =
        error.code === "last_identity" || error.code === "setup_claimed"
          ? "conflict"
          : error.code === "forbidden"
            ? "forbidden"
            : error.code === "missing_identity" || error.code === "missing_provider"
              ? "not_found"
              : "unauthorized";
      throw new ApiHttpError(
        kind,
        error.code === "last_identity"
          ? "link another identity before removing this one"
          : error.code === "setup_claimed"
            ? "this server has already been claimed by another owner"
            : "account operation is not permitted",
      );
    }
    throw new ApiHttpError("internal", "account operation failed");
  }
}
