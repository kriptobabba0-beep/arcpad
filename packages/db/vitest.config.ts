import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `test/setup.ts` her dosyadan once `DROP SCHEMA public CASCADE` calistirir.
    // Dosyalar PARALEL kosarsa bir dosyanin drop'u digerinin tablolarini altindan
    // ceker ve arizanin sekli her kosuda degisir. Bu satir yoksa suite bazen
    // yesil olur -- yani "yazilmamis bir gerekce yuzunden gecen test"in tam
    // tanimi. Tek veritabani, tek dosya, sirayla.
    fileParallelism: false,
    setupFiles: ['./test/setup.ts'],
  },
})
