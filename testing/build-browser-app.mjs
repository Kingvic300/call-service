// Bundles browser-app/client.ts (mediasoup-client + socket.io-client) into a
// single browser-runnable file. Needed because both libraries assume a
// bundler; Playwright pages just load a plain <script> tag.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['browser-app/client.ts'],
  bundle: true,
  outfile: 'browser-app/dist/client.js',
  format: 'iife',
  globalName: 'CallClientBundle',
  platform: 'browser',
  target: 'chrome115',
  sourcemap: false,
  logLevel: 'info',
});
