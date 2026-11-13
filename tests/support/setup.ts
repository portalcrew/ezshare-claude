import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach } from "vitest";

// Every scenario starts with a browser profile of its own.
beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});
