const { getDefaultConfig } = require("expo/metro-config");
const exclusionList = require("metro-config/src/defaults/exclusionList");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.blockList = exclusionList([
  /android\/build\/.*/,
  /android\/app\/build\/.*/,
  /node_modules\/.*\/android\/build\/.*/,
]);

// React Native core needs event-target-shim v5 (callable factory API,
// `EventTarget(...events)`). The monorepo also has v6 (class-only) under
// apps/mobile + react-native-webrtc; with disableHierarchicalLookup RN core
// otherwise resolves to v6 and the WebSocket layer crashes at startup
// ("Cannot call a class as a function"). Route ONLY RN-core's bare import to
// the workspace-root v5 copy; every other package keeps its own version.
const eventTargetShimV5 = require.resolve("event-target-shim", {
  paths: [path.resolve(workspaceRoot, "node_modules")],
});
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "event-target-shim") {
    const origin = context.originModulePath || "";
    const inRnCore =
      origin.includes(path.join("node_modules", "react-native", "Libraries")) ||
      origin.includes(path.join("node_modules", "react-native", "src"));
    if (inRnCore) {
      return { type: "sourceFile", filePath: eventTargetShimV5 };
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
