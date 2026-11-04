/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "web-not-server",
      severity: "error",
      from: { path: "^src/web" },
      to: { path: "^src/server" },
    },
    {
      name: "shared-imports-nothing-internal",
      severity: "error",
      from: { path: "^src/shared" },
      to: { path: "^src/(server|web)" },
    },
    {
      name: "feature-cross-import-only-api",
      comment: "A slice may use another slice only through its api.ts",
      severity: "error",
      from: { path: "^src/server/features/([^/]+)/" },
      to: {
        path: "^src/server/features/([^/]+)/",
        pathNot: ["^src/server/features/$1/", "^src/server/features/[^/]+/api\\.ts$"],
      },
    },
    {
      name: "conformance-black-box",
      comment:
        "The suite reaches a server only over the wire, so it may not import server internals",
      severity: "error",
      from: { path: "^conformance" },
      to: {
        path: "^(src|scripts)/",
        pathNot: [
          "^src/shared/",
          "^scripts/fake-acp-agent\\.ts$",
          "^src/server/test-support/soft-authenticator\\.ts$",
        ],
      },
    },
    {
      name: "no-orphans",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "\\.test\\.ts$",
          "(^|/)[^/]+\\.config\\.(c|m)?[jt]s$",
          "(^|/)\\.[^/]+\\.(c|m)?js$",
          "^src/main\\.ts$",
          "^src/server/test-support/no-git-env\\.ts$",
          "^scripts/",
          "^conformance/(differential|fake-agent)\\.ts$",
          "\\.d\\.ts$",
          "^src/web/pwa/sw\\.js$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
