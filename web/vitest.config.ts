import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * `@/…` -- `tsconfig.json`'daki yol takma adinin Vite karsiligi.
 *
 * Vitest tsconfig `paths`'i KENDILIGINDEN okumaz. Okuduğunu varsaymak, bir
 * bilesen testinin "modul bulunamadi" ile degil, sessizce farkli bir modulu
 * cozerek kirilmasi demektir.
 */
const webRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/')
const alias = [{ find: /^@\//, replacement: webRoot }]

/**
 * IKI PROJE, IKI ORTAM.
 *
 * `unit` node'da kosar ve saf mantigi olcer (adres defteri, preflight, kontrast
 * kapisi -- sonuncusu bir CSS dosyasini okur, DOM'a ihtiyaci yoktur).
 * `component` jsdom'da kosar ve React agacini gercekten cizer.
 *
 * Tek bir jsdom projesi de kurulabilirdi ama jsdom bir node testinin
 * gormemesi gereken globalleri (`window`, `document`) tanimlar: sunucu
 * tarafinda calisacak bir modul yanlislikla `window`'a dokundugunda test yesil
 * kalir ve hata uretimde cikar.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['test/**/*.test.tsx'],
          setupFiles: ['./test/setup.ts'],
        },
      },
    ],
  },
})
