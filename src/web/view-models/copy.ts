import { accountName, type SharedAccount } from "../../shared/accounts.ts";
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
            return "GitHub denied reading shared-account metadata or the repository encryption key. This step requires repository permission Secrets: Read. To complete account sharing, set Secrets to Read and write.";
        case "secrets_write_forbidden":
            return "GitHub denied saving or removing a shared Claude account. This step requires repository permission Secrets: Read and write.";
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
        case "history_too_large":
            return "The workspace is too large to save. The previous saved history was kept.";
        case "history_key_missing":
            return "The runner did not receive your personal history key. Keep this launcher open and start again. It did not create a new Computer or replace your saved history.";
        case "account_name_invalid":
            return "Enter a short account name (up to 36 English characters or 12 Chinese characters).";
        case "account_name_taken":
            return "An account already uses this name. Choose another name, or reauthorize the existing account.";
        case "shared_account_missing":
            return "No Claude account has been shared with this repository yet. Ask the account owner to share one.";
        case "agent_failed":
            return "Claude could not start. If this keeps happening, ask the account owner to share the account again.";
        case "vscode_unavailable":
            return "VS Code could not connect. Start a new session and authorize again if asked.";
        case "morty_unavailable":
            return "Morty could not connect. Try “Use a new Morty identity” when starting again, or choose VS Code. Your saved Claude history is kept.";
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
        url.searchParams.set("secrets", secrets ? "write" : "read");
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
    headline: "Shared accounts, private sessions.",
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
        "For chatting with an account someone else shared. Includes Actions and Issues read and write, plus Secrets read to list shared accounts. Secret values cannot be read through this API.",
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
        beforeLogin: "GitHub: ",
        beforeRepository: " · ",
    },
    disconnect: "Disconnect",
    identityHint:
        "This verifies your identity and repository access. Session and account-sharing permissions are checked when you use them.",
    publicTitle: "Public repository · Privacy details",
    privateTitle: "Privacy and access",
    privateBody: "Session activity is visible to people with repository access.",
    historyPrivacy: "Saved conversations and workspaces are encrypted with a key kept in this browser.",
    accountPrivacy:
        "The Claude credential is shared with repository members. People who can change workflow code control what runs in your session.",
    publicBody: "Anyone can see when sessions start and end.",
    sections: "Sections",
    pages: {
        use: "Use a shared account",
        share: "Manage shared accounts",
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
            ". Sessions need Actions and Issues read and write, and Secrets read to list accounts. Sharing your account also needs Secrets read and write. If the token is pending organization approval, ask an organization owner to approve it. Your GitHub account also needs write access to the repository.",
    },
    replace: "Replace GitHub token",
    replaceHint:
        "Replacing the token disconnects this browser. It does not stop a running session or erase history keys.",
} as const;

export const chatCopy = {
    title: "Your Claude session",
    refresh: "Refresh now",
    loading: "Checking your session…",
    intro: `Use the team's Claude account in a personal workspace. Sessions last up to ${chatLifetime}.`,
    replacingHistory:
        "Your next session starts with an empty history and saves it in place of the one this browser cannot read.",
    start: "Start a session",
    newMortyIdentity: "Use a new Morty identity",
    newMortyIdentityHint:
        "Deletes this session’s restored Morty state and creates a new Computer. Your Claude conversation and workspace are kept. Previous Morty links will not connect to this new session.",
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
            ". The first start usually takes two to four minutes. Keep this launcher open so it can unlock your personal state and let you save and end the session.",
    },
    readyTitle: "Ready",
    access: "Open with",
    clients: { morty: "Morty", vscode: "VS Code · Browser", "vscode-desktop": "VS Code · Desktop" },
    changeClient: "Change access method",
    clientHint: "Your choice is remembered in this browser.",
    switchClientHint: "Switching access methods keeps this session running.",
    estimatedTime: "Estimated time left",
    idleHint: `Ends earlier after ${chatIdleStop} without a message.`,
    saveHint: "Encrypted saves run after startup, every five minutes, and when you end this session.",
    forceStopHint: "Use only if saving is stuck. Unsaved changes may be lost; the previous saved history is kept.",
    savingHelp: "Saving taking too long?",
    stoppingForced: "Stopping immediately. Changes may not be saved.",
    desktopHelp:
        "Browser traffic is configured to use the runner. Choose View → Browser in desktop VS Code and check the remote indicator.",
    webHelp: "Sign in with the GitHub account you authorized, then choose a conversation in the Claude Code extension.",
    vscodeAuthorizationTitle: "Authorize VS Code",
    vscodeAuthorizationWaiting: "Waiting for GitHub authorization. This page updates automatically.",
    vscodeAuthorizationHint:
        "Open GitHub, enter this code, and approve Visual Studio Code. Use the same GitHub account when opening VS Code. Your Claude account does not need another login.",
    vscodeAuthorize: "Authorize VS Code",
    vscodeOpen: "Open VS Code in browser",
    vscodeDesktopOpen: "Open in desktop VS Code",
    open: "Open chat",
    readyHint:
        "This link gives access to your session. Keep it private. Keep this page open to save and end the session.",
    end: "Save and end session",
    endWithoutSave: "End session",
    saving: "Saving and ending your session…",
    stopping: "Ending your session…",
    forceStop: "Force stop without saving",
    failedTitle: "Your last session ended with a problem",
    history: {
        restored: "Your previous conversation and workspace are restored.",
        new: "New workspace. Your history will be saved when you end this session.",
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
                : "Your last session ended. The final save did not complete. You can still continue from your most recent saved copy, if one exists.";
        case "expired":
            return "Your last session reached its time limit and ended.";
        case "failed":
            return errorMessage(outcome.code);
        default:
            return outcome satisfies never;
    }
}

export const sharingCopy = {
    title: "Shared Claude accounts",
    method: "Authorize Claude using",
    browserMethod: "This browser",
    runnerMethod: "Runner · Desktop VS Code",
    runnerMethodHint:
        "Use the runner's IP for Claude sign-in. Requires desktop VS Code. This temporary workspace does not load or save your conversations.",
    vscodeConnectTitle: "Connect the authorization workspace",
    vscodeConnectHint:
        "Approve Visual Studio Code on GitHub, then sign into desktop VS Code with that same GitHub account. Claude authorization comes next.",
    vscodeConnect: "Authorize VS Code",
    vscodeOpen: "Open authorization workspace in VS Code",
    vscodeWaiting: "Waiting for GitHub authorization. This page updates automatically.",
    runnerBrowserHint:
        "In that VS Code window, choose View → Browser. Confirm its address bar shows a connection through the runner, then paste the link below into that Integrated Browser and sign into Claude. Opening it in Chrome uses your local network.",
    runnerReturnCode: "After approving Claude, copy the authorization code back here.",
    authorizationLink: "Claude authorization link",
    copyAuthorization: "Copy authorization link",
    authorizationCopied: "Copied. Paste it into the Integrated Browser in your remote VS Code window.",
    authorizationManualCopy:
        "Clipboard access was blocked. The link is selected; copy it and paste it into Integrated Browser.",
    progress: "Sharing progress",
    steps: ["Start", "Authorize on claude.ai", "Store for the team"],
    loading: "Checking for an authorization in progress…",
    intro: "Give every member of this repository a Claude session that uses your Claude account. You authorize once on claude.ai; the resulting token is stored as an encrypted repository secret and never kept in this browser.",
    risksTitle: "Before you share",
    risks: [
        "Every member with write access can read the token from inside their own session and keep using it elsewhere. Share only with people you would give your account to.",
        "The token stays valid for one year unless you revoke it on claude.ai.",
        "Reauthorizing replaces only the selected account. Adding an account keeps existing accounts.",
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
        afterLink:
            ". Removing an account here prevents new sessions from choosing it; revoke it on Claude to also invalidate copied credentials.",
    },
    sharedAnnouncement: "Your Claude account is shared with the team.",
    sharedTitle: "Shared with the team",
    sharedBody: "Members can now start sessions with your account.",
    cancelled: "Authorization cancelled. Nothing was shared.",
    failedTitle: "Sharing did not complete",
} as const;

export function sharedAccountLabel(account: Pick<SharedAccount, "name">): string {
    return account.name ?? "Previously shared account";
}

export function sessionAccountLabel(id: string): string {
    return sharedAccountLabel({ name: accountName(id) });
}

export const accountsCopy = {
    title: "Shared accounts",
    count: (count: number) => `${count} shared ${count === 1 ? "account" : "accounts"}`,
    loading: "Checking shared accounts…",
    failed: "Could not check shared accounts",
    retry: "Check accounts again",
    empty: "No accounts shared yet",
    emptyHint: "Share a Claude account to let repository members start private sessions.",
    share: "Share a Claude account",
    shared: "Shared",
    availability: "A stored credential is available. Claude checks whether it is still valid when a session starts.",
    picker: "Claude account",
    choose: "Choose an account",
    add: "Add account",
    back: "Back to accounts",
    name: "Account name",
    writeAccess: "Adding, reauthorizing, or removing accounts requires a GitHub token with Secrets: Read and write.",
    nameHint:
        "Use a short label your team will recognize. This label is visible to people who can list repository secrets.",
    reauthorize: "Reauthorize",
    remove: "Remove",
    removeAction: "Remove account",
    removeTitle: (name: string) => `Remove ${name}?`,
    removeHint:
        "New sessions will no longer be able to select this account. Running sessions can keep using this credential. Conversation history is kept. Revoke the token on Claude to invalidate any copies.",
    replaceHint: (name: string) => `Reauthorize ${name}. Only this account's stored credential will be replaced.`,
    authorizeTitle: "Authorize the account",
    updated: (date: string) => `Updated ${new Date(date).toLocaleString()}`,
    using: (name: string) => `Account: ${name}`,
} as const;
