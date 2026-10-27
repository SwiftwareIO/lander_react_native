const path = require('path')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

const root = path.resolve(__dirname, '..')
const escape = (s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')

/**
 * Bundles react-native-lander from its TypeScript source in the parent folder.
 * The library's own node_modules (with its dev copies of react and
 * react-native) is blocked, so there is one React Native in the bundle.
 *
 * @type {import('metro-config').MetroConfig}
 */
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [root],
  resolver: {
    blockList: [new RegExp(`^${escape(path.join(root, 'node_modules'))}\\/.*$`)],
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === 'react-native-lander') {
        return { type: 'sourceFile', filePath: path.join(root, 'src', 'index.ts') }
      }
      return context.resolveRequest(context, moduleName, platform)
    },
  },
})
