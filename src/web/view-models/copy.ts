import { repositoryName } from "../../shared/github/client.ts";
import type { ConnectionError } from "./application-store.ts";

/** User-facing text for every failure code. Each message says what happened and what to do next. */
export function errorMessage(code: ConnectionError): string {
    switch (code) {
        case "classic_token":
            return "This looks like a classic token. Create a fine-grained token limited to this repository instead.";
        case "cancelled":
            return "The request was cancelled.";
        case "timeout":
            return "GitHub took too long to answer. Try again in a moment.";
        case "invalid_input":
            return "Check the repository name (owner/name) and paste the complete token.";
        case "unauthenticated":
            return "GitHub did not accept this token. It may have expired or been revoked; create a new one.";
        case "forbidden":
            return "Your token is missing a permission for this step. Check the permissions listed in the setup steps.";
        case "not_found":
            return "GitHub could not find this repository, or your token cannot see it. Check the name and the token's repository access.";
        case "conflict":
            return "GitHub did not accept the request, probably because the session already changed. Your status will refresh shortly.";
        case "rate_limited":
            return "GitHub is limiting requests right now. Status will refresh automatically in a few minutes.";
        case "github_unavailable":
            return "GitHub could not be reached. Status will refresh automatically when it is back.";
        case "invalid_response":
            return "GitHub sent an answer that could not be verified, so nothing was changed. Try again shortly.";
        case "unsafe_execution":
            return "The session run could not be verified as yours, so it was not trusted. Start a new session.";
        case "session_busy":
            return "You already have a session running in this repository. End it before starting another.";
        case "storage_unavailable":
            return "This browser blocked local storage for the launcher. Allow site data and reload.";
        case "shared_account_missing":
            return "No Claude account has been shared with this repository yet. Ask the account owner to share one.";
        case "agent_failed":
            return "Claude could not start. If this keeps happening, ask the account owner to share the account again.";
        case "morty_unavailable":
            return "Morty could not connect. Start a new session in a few minutes.";
        case "provider_failed":
            return "Claude did not complete the authorization. Start again and paste the newest code.";
        case "expired":
            return "This session has expired. Start a new one.";
        case "unexpected":
            return "Something unexpected went wrong. Reload the page and try again.";
        default:
            return code satisfies never;
    }
}

export interface TokenTemplates {
    readonly owner: string;
    readonly name: string;
    readonly member: string;
    readonly ownerSharing: string;
}

/**
 * Links to GitHub's fine-grained token form, prefilled for this repository. GitHub still asks the member to pick
 * the repository; the template only preselects the owner and permissions.
 */
export function tokenTemplates(repository: string): TokenTemplates | null {
    let name: string;
    try {
        name = repositoryName(repository);
    } catch {
        return null;
    }
    const [owner = "", repo = ""] = name.split("/");
    const template = (secrets: boolean) => {
        const url = new URL("https://github.com/settings/personal-access-tokens/new");
        url.searchParams.set("name", secrets ? `ezshare-claude owner (${repo})` : `ezshare-claude (${repo})`);
        url.searchParams.set("description", `ezshare-claude for ${name}. Select only this repository.`);
        url.searchParams.set("target_name", owner);
        url.searchParams.set("expires_in", "30");
        url.searchParams.set("actions", "write");
        url.searchParams.set("issues", "write");
        if (secrets) {
            url.searchParams.set("secrets", "write");
        }
        return url.href;
    };
    return { owner, name: repo, member: template(false), ownerSharing: template(true) };
}
