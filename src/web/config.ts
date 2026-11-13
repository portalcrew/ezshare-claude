import { AppError } from "../shared/errors.ts";
import { repositoryName } from "../shared/github/client.ts";

/** Deployment input is public configuration, never an authenticated identity or credential. */
const configured: unknown = import.meta.env["VITE_DEFAULT_REPOSITORY"];
if (configured !== undefined && typeof configured !== "string") {
    throw new AppError("invalid_input");
}
const value = configured ?? "";
export const DEFAULT_REPOSITORY = value.trim() === "" ? "" : repositoryName(value);
