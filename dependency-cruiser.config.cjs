/** Architecture boundaries; `pnpm check:architecture` fails on any violation. */
module.exports = {
    forbidden: [
        {
            name: "shared-is-environment-neutral",
            severity: "error",
            comment: "Shared contracts run in both the browser and the Actions runner; they import neither.",
            from: { path: "^src/shared/" },
            to: { path: ["^src/web/", "^src/runner/"] },
        },
        {
            name: "browser-does-not-import-runner",
            severity: "error",
            from: { path: "^src/web/" },
            to: { path: "^src/runner/" },
        },
        {
            name: "runner-does-not-import-browser",
            severity: "error",
            from: { path: "^src/runner/" },
            to: { path: "^src/web/" },
        },
        {
            name: "components-do-not-import-business-layers",
            severity: "error",
            comment: "Components render what they receive; type-only imports of view-model contracts are allowed.",
            from: { path: "^src/web/components/" },
            to: {
                path: ["^src/web/views/", "^src/web/view-models/", "^src/web/services/"],
                dependencyTypesNot: ["type-only"],
            },
        },
        {
            name: "view-models-do-not-import-views",
            severity: "error",
            from: { path: "^src/web/view-models/" },
            to: { path: ["^src/web/views/", "^src/web/components/"], dependencyTypesNot: ["type-only"] },
        },
        {
            name: "stores-live-in-view-models",
            severity: "error",
            comment: "Zustand stores are created only in the view-model layer.",
            from: { path: "^src/web/", pathNot: "^src/web/view-models/" },
            to: { path: "/node_modules/zustand/esm/vanilla", dependencyTypesNot: ["type-only"] },
        },
        {
            name: "no-circular",
            severity: "error",
            from: {},
            to: { circular: true },
        },
    ],
    options: {
        doNotFollow: { path: "node_modules" },
        tsPreCompilationDeps: true,
        tsConfig: { fileName: "tsconfig.json" },
        enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
    },
};
