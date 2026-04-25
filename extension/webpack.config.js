const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    entry: {
      'background/service-worker': path.join(srcDir, 'background/service-worker.js'),
      'content/content': path.join(srcDir, 'content/content.js'),
      'popup/popup': path.join(srcDir, 'popup/popup.js'),
      'options/options': path.join(srcDir, 'options/options.js'),
    },
    output: {
      path: distDir,
      filename: '[name].js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [['@babel/preset-env', { targets: { chrome: '100', edge: '100' }, modules: false }]],
            },
          },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        // Inline WASM files as assets (needed for argon2 & libsodium)
        {
          test: /\.wasm$/,
          type: 'asset/resource',
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.join(srcDir, 'popup/popup.html'),
        filename: 'popup/popup.html',
        chunks: ['popup/popup'],
        inject: true,
      }),
      new HtmlWebpackPlugin({
        template: path.join(srcDir, 'options/options.html'),
        filename: 'options/options.html',
        chunks: ['options/options'],
        inject: true,
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: path.join(__dirname, 'manifest.json'), to: distDir },
          { from: path.join(__dirname, 'icons'), to: path.join(distDir, 'icons') },
          // Copy WASM files for argon2-browser
          {
            from: path.resolve(__dirname, 'node_modules/argon2-browser/dist/argon2.wasm'),
            to: path.join(distDir, 'crypto/argon2.wasm'),
            noErrorOnMissing: true,
          },
        ],
      }),
    ],
    resolve: {
      extensions: ['.js'],
      // Use the CommonJS/UMD versions of libs that have broken ESM entry points in the browser
      alias: {
        // libsodium-wrappers exports an ESM build that references missing .mjs files.
        // Alias directly to the CJS entry resolved by Node's require().
        'libsodium-wrappers': require.resolve('libsodium-wrappers'),
        // argon2-browser: use the bundled build (includes WASM inline)
        'argon2-browser': path.join(
          path.dirname(require.resolve('argon2-browser')),
          '../dist/argon2-bundled.min.js',
        ),
      },
      fallback: {
        // Browser polyfills for Node core modules used by some deps
        crypto: false,
        stream: false,
        buffer: false,
        path: false,
        fs: false,
      },
    },
    devtool: isDev ? 'cheap-source-map' : false,
    // Increase performance hints threshold for crypto-heavy bundles
    performance: {
      maxEntrypointSize: 10 * 1024 * 1024,
      maxAssetSize: 10 * 1024 * 1024,
    },
  };
};

