import { defineConfig, loadEnv } from 'vite';
import { localExportPlugin } from './server/localExportPlugin';
import { audioDenoisePlugin } from './server/audioDenoisePlugin';
import { localAlignmentPlugin } from './server/alignmentPlugin';
import { diskDraftPlugin } from './server/draftPlugin';
import { volcAsrPlugin } from './server/asrPlugin';
import { roughCutPlugin } from './server/roughCutPlugin';
import { deepseekDupPlugin } from './server/deepseekPlugin';
import { healthPlugin } from './server/healthPlugin';

export default defineConfig(({ mode }) => {
  // Empty prefix: load VOLC_* / DEEPSEEK_* from .env / .env.local into process.env for proxies.
  const env = loadEnv(mode, process.cwd(), '');
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };

  return {
    server: {
      fs: { deny: ['**/.podcast-drafts/**', '**/.alignment-*/**', '**/.env*', '**/*.{crt,pem}', '**/.git/**'] },
      port: 5188,
      host: '127.0.0.1',
      strictPort: true,
      // Avoid full reloads from backup / sync noise (B2: Averie mid-edit refresh).
      watch: {
        ignored: [
          '**/*.bak*',
          '**/*.restored',
          '**/dist/**',
          '**/.git/**',
          '**/pending-mac-sync.txt',
          '**/node_modules/**',
          '**/*.md',
          '**/docs*/**',
          '**/.env*',
          '**/agent-tools/**',
          '**/uploads/**',
          '**/.podcast-drafts/**',
          '**/.alignment-*/**',
        ],
      },
      // Keep HMR; full reload still restores from IndexedDB (B2 critical).
      hmr: { overlay: true },
    },
    build: { target: 'es2022', rollupOptions: { input: {main: 'index.html', export: 'export.html', publication: 'publication.html'} } },
    preview: {host:'127.0.0.1',port:5188,strictPort:true},
    plugins: [healthPlugin(), localExportPlugin(), audioDenoisePlugin(), localAlignmentPlugin(), diskDraftPlugin(), volcAsrPlugin(merged), deepseekDupPlugin(merged), roughCutPlugin(merged)],
  };
});
