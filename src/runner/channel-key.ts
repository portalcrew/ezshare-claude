import { appendFile, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChannelKey, createPortableChannelKey, importChannelKey } from "../shared/channel-crypto.ts";
import { AppError } from "../shared/errors.ts";
import { signerArtifactName } from "../shared/protocol.ts";

/**
 * The runner's channel key crosses one step boundary: the preparing step writes it to a private file and names an
 * artifact after its public half; the upload step publishes that artifact; the session step loads and deletes it.
 */
function paths(runnerTemp: string) {
    const directory = join(runnerTemp, "ezshare-channel");
    return {
        directory,
        privateKey: join(directory, "private-key"),
        publicKey: join(directory, "public-key"),
        artifact: join(directory, "artifact", "channel.txt"),
    };
}

export async function prepareChannelKey(runnerTemp: string, githubOutput: string): Promise<{ readonly name: string }> {
    const files = paths(runnerTemp);
    await mkdir(join(files.directory, "artifact"), { recursive: true, mode: 0o700 });
    await chmod(files.directory, 0o700);
    const key = await createPortableChannelKey();
    try {
        await writeFile(files.privateKey, key.pkcs8, { mode: 0o600, flag: "wx" });
    } finally {
        key.pkcs8.fill(0);
    }
    await writeFile(files.publicKey, key.publicKey, { mode: 0o600, flag: "wx" });
    await writeFile(files.artifact, "ezshare-claude session channel\n", { mode: 0o644, flag: "wx" });
    const name = signerArtifactName(key.publicKey);
    await appendFile(githubOutput, `artifact-name=${name}\nartifact-path=${files.artifact}\n`);
    return { name };
}

export async function loadChannelKey(runnerTemp: string): Promise<ChannelKey> {
    const files = paths(runnerTemp);
    try {
        const info = await lstat(files.privateKey);
        if (!info.isFile() || (info.mode & 0o077) !== 0) {
            throw new AppError("unsafe_execution");
        }
        const publicKey = (await readFile(files.publicKey, "utf8")).trim();
        return await importChannelKey(new Uint8Array(await readFile(files.privateKey)), publicKey);
    } catch (cause) {
        throw cause instanceof AppError ? cause : new AppError("unsafe_execution", { cause });
    } finally {
        await rm(files.privateKey, { force: true });
    }
}
