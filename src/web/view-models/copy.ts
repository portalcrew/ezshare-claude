import { repositoryName, type WorkflowRun } from "../../shared/github/client.ts";
import { CHAT_IDLE_STOP_MS, lifetime } from "../../shared/protocol.ts";
import type { ConnectionError, Page } from "./application-store.ts";
import type { ChatOutcome } from "./chat-store.ts";

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
        case "actions_read_forbidden":
            return "GitHub denied reading session status. This step requires repository permission Actions: Read. Set Actions to Read and write to also start and stop sessions.";
        case "actions_write_forbidden":
            return "GitHub denied starting or stopping a session. This step requires repository permission Actions: Read and write.";
        case "issues_read_forbidden":
            return "GitHub denied reading the encrypted session channel. This step requires repository permission Issues: Read. Set Issues to Read and write to also send session messages.";
        case "issues_write_forbidden":
            return "GitHub denied updating the encrypted session channel. This step requires repository permission Issues: Read and write.";
        case "secrets_read_forbidden":
            return "GitHub denied reading the repository secret encryption key. This step requires repository permission Secrets: Read. To complete account sharing, set Secrets to Read and write.";
        case "secrets_write_forbidden":
            return "GitHub denied saving the shared Claude account. This step requires repository permission Secrets: Read and write.";
        case "contents_read_forbidden":
            return "GitHub denied checking the default branch. This step requires repository permission Contents: Read.";
        case "forbidden":
            return "GitHub denied this operation. Check the token's repository selection and required permissions, organization approval, and your account's repository access.";
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

// Screen text. A sentence that wraps an element (a link, a button, bold text) is split into named fragments in
// reading order; the view places the element between them.

/** A whole number of hours or minutes in English, e.g. "4 hours" or "15 minutes". */
function duration(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return hours === 1 ? "1 hour" : `${hours} hours`;
    }
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const chatLifetime = duration(lifetime("chat"));
const chatIdleStop = duration(CHAT_IDLE_STOP_MS);

/** Text used by more than one screen. */
export const commonCopy = {
    staleStatusTitle: "Status may be out of date",
    cancel: "Cancel",
    memberTokenLink: "Create a token to use the team account",
    ownerTokenLink: "Create a token to share my Claude account",
} as const;

export const launcherCopy = {
    product: "ezshare-claude",
    headline: "One team account, private sessions.",
    tagline: "Use Claude Code with the account your team shares, in a session only you can reach.",
} as const;

export const connectCopy = {
    title: "Connect to GitHub",
    restoring: "Restoring your connection…",
    disconnecting: "Removing your token…",
    failedTitle: "Could not connect",
} as const;

export const connectionFormCopy = {
    stepLabel: (step: number) => `Step ${step}: `,
    repositoryStep: "Confirm the team repository",
    repositoryLabel: "Repository",
    repositoryPlaceholder: "owner/name",
    tokenStep: "Create a fine-grained GitHub token",
    noTemplates: "Enter the repository as owner/name to get a prefilled token link.",
    templates: {
        beforeOwner: "Choose what you want to do. Both links select ",
        afterOwner: " as the resource owner. Under Repository access choose ",
        accessChoice: "Only select repositories",
        beforeName: " and pick ",
        afterName: ".",
    },
    memberLink: commonCopy.memberTokenLink,
    memberHint:
        "For chatting with an account someone else shared. Includes Actions and Issues read and write; does not include Secrets access.",
    ownerLink: commonCopy.ownerTokenLink,
    ownerHint:
        "For authorizing and sharing your own account, and chatting. Includes Actions, Issues and Secrets read and write.",
    approvalHint: "Organizations may require an administrator to approve new tokens.",
    connectStep: "Paste the token and connect",
    tokenLabel: "GitHub token",
    tokenHint:
        "The token is stored encrypted in this browser so you stay connected after a reload. Use Disconnect to remove it.",
    connect: "Connect",
} as const;

/** The connection form is a business-agnostic component, so it receives its text as a prop. */
export type ConnectionFormCopy = typeof connectionFormCopy;

export const workspaceCopy = {
    identity: {
        beforeLogin: "GitHub identity verified as ",
        beforeRepository: " for ",
    },
    disconnect: "Disconnect",
    identityHint:
        "This verifies your identity and repository access. Session and account-sharing permissions are checked when you use them.",
    publicTitle: "This repository is public",
    publicBody:
        "Anyone can see when sessions start and end. What you type, links and tokens are encrypted between your browser and your session.",
    sections: "Sections",
    pages: {
        use: "Use the team account",
        share: "Share your account",
    } satisfies Record<Page, string>,
} as const;

export const tokenAccessCopy = {
    title: "GitHub access needs attention",
    announcement: "GitHub denied an operation. Review your token permissions or replace your token.",
    denied: {
        beforeRepository: "GitHub recognizes you, but denied an operation in ",
        afterRepository: ". Signing in does not grant permission to start sessions or share an account.",
    },
    instructions: {
        beforeOwner: "Select ",
        beforeRepository: " as the token's resource owner and allow access to",
        afterRepository:
            ". Sessions need Actions and Issues read and write. Sharing your account also needs Secrets read and write. If the token is pending organization approval, ask an organization owner to approve it. Your GitHub account also needs write access to the repository.",
    },
    replace: "Replace GitHub token",
    replaceHint:
        "Replacing the token disconnects this browser. It does not stop a running session or erase history keys.",
} as const;

export const chatCopy = {
    title: "Your Claude session",
    refresh: "Refresh now",
    loading: "Checking your session…",
    intro: `Start a private Claude session that uses the team account. A session lasts up to ${chatLifetime} and ends early after ${chatIdleStop} without a message. When it ends, your conversation and workspace are encrypted with a key that only this browser keeps, and the next session continues from them.`,
    replacingHistory:
        "Your next session starts with an empty history and saves it in place of the one this browser cannot read.",
    start: "Start a session",
    busyTitle: "You already have a session running",
    busyBody: "Only one session per member can run at a time. End it before starting another.",
    endRun: (id: string) => `End run ${id}`,
    requested: "Session requested.",
    preparing: "Preparing your session.",
    progress: "Session progress",
    steps: ["Requested", "Waiting for a runner", "Preparing Claude", "Ready"],
    waiting: {
        beforeElapsed: "Waiting ",
        afterElapsed:
            ". The first start usually takes two to four minutes. You can close this page; it picks up where you left off.",
    },
    readyAnnouncement: "Your session is ready.",
    readyTitle: "Your session is ready",
    readyBody: "Claude is running with the team account in a workspace only you can reach.",
    open: "Open chat",
    readyHint: `Anyone with this link can use your session until it ends, so do not share it. The session ends after ${chatLifetime}, or after ${chatIdleStop} without a message. End it here when you are done, so your history is saved.`,
    end: "End session",
    stoppingAnnouncement: "Ending your session.",
    stopping: "Ending your session…",
    forceStop: "End immediately (skips cleanup)",
    failedTitle: "Your last session ended with a problem",
    history: {
        restored: "Your previous conversation and workspace are restored.",
        new: "This is your first saved session; its history is kept when it ends.",
        off: "History is off for this session, because this page was closed while it started.",
        unreadableTitle: "Your saved history could not be opened",
        unreadable:
            "It was saved from another browser, or this browser's site data was cleared. This session starts empty and does not overwrite it.",
        willReplace: "Your next session will replace it.",
        replace: "Replace it from the next session",
    },
} as const;

/** The link text for a run that keeps the member from starting a session. */
export function blockingRunLabel(run: WorkflowRun): string {
    return `${run.path.endsWith("login.yml") ? "Account sharing run" : "Session run"} ${run.id}`;
}

/** How the member's previous session ended. */
export function chatOutcomeText(outcome: ChatOutcome): string {
    switch (outcome.kind) {
        case "stopped":
            return outcome.history === "archived"
                ? "Your last session ended. Its history is saved for your next session."
                : "Your last session ended. Its history was not saved.";
        case "expired":
            return "Your last session reached its time limit and ended.";
        case "failed":
            return errorMessage(outcome.code);
        default:
            return outcome satisfies never;
    }
}

export const sharingCopy = {
    title: "Share your Claude account",
    progress: "Sharing progress",
    steps: ["Start", "Authorize on claude.ai", "Store for the team"],
    loading: "Checking for an authorization in progress…",
    intro: "Give every member of this repository a Claude session that uses your Claude account. You authorize once on claude.ai; the resulting token is stored as an encrypted repository secret and never kept in this browser.",
    risksTitle: "Before you share",
    risks: [
        "Every member with write access can read the token from inside their own session and keep using it elsewhere. Share only with people you would give your account to.",
        "The token stays valid for one year unless you revoke it on claude.ai.",
        "Sharing replaces any account already shared with this repository.",
        "Check that your Claude plan's terms allow use by your team.",
    ],
    unprotectedTitle: "The default branch is not protected",
    unprotectedBody:
        "Anyone with write access can change the code that receives your token. Protect the default branch and require reviews before sharing.",
    start: "I understand, start authorization",
    waitingAnnouncement: "Waiting for the authorization link.",
    waiting: "Starting Claude's login. The authorization link appears here in about a minute.",
    authorizingAnnouncement: "The authorization link is ready.",
    authorize: {
        link: "Open the Claude authorization page",
        afterLink: " and sign in with the account you want to share.",
    },
    pasteCode: "Copy the code Claude shows and paste it below.",
    codeLabel: "Authorization code",
    codeHint: "The code is encrypted for this login run before it leaves your browser.",
    submitCode: "Submit code",
    completingAnnouncement: "Completing the authorization.",
    completing: "Claude is completing the authorization…",
    publishing: "Storing the account for the team…",
    stopSharing: {
        beforeLink: "To stop sharing, revoke the token in ",
        link: "your Claude account settings",
        url: "https://claude.ai/settings",
        afterLink: " and delete the repository secret.",
    },
    sharedAnnouncement: "Your Claude account is shared with the team.",
    sharedTitle: "Shared with the team",
    sharedBody: "Members can now start sessions with your account.",
    cancelled: "Authorization cancelled. Nothing was shared.",
    failedTitle: "Sharing did not complete",
} as const;
