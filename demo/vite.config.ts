import { fileURLToPath, URL } from 'node:url'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import catalog from './catalog.json'

const demoRoot = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  root: demoRoot,
  plugins: [
    tanstackStart({
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: true,
        crawlLinks: true,
        concurrency: 8,
        failOnError: true,
      },
      pages: catalog.languages.flatMap(({ code }) => [
        { path: `/${code}` },
        { path: `/${code}/view/sans` },
        { path: `/${code}/view/serif` },
      ]),
    }),
    react(),
  ],
  server: {
    fs: { allow: [packageRoot] },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: fileURLToPath(new URL('../demo-dist', import.meta.url)),
    emptyOutDir: true,
  },
})
