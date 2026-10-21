import { defineConfig } from 'vite'

export default defineConfig({
  // The viewer imports the simulation directly, so there is no build-time split to
  // configure — and that is the point (ADR-001 §2.2): there is exactly one
  // implementation of the simulation and the browser runs it.
  server: { port: 5173, open: false },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        // Two entry points: the house inspection playpen, and the yacht domain
        // scene. Both are views over content; neither is a separate simulation.
        main: 'index.html',
        yacht: 'index-yacht.html',
      },
    },
  },
})
