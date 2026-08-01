import type { ReactNode } from 'react'
import { Footer } from './Footer'
import { Header } from './Header'
import { NetworkBanner } from './NetworkBanner'

/**
 * KABUK, `layout.tsx`'ten AYRI BIR BILESEN OLARAK.
 *
 * Sebep test edilebilirlik ve olculebilir: `layout.tsx` `next/font/local`
 * cagiran `app/fonts.ts`'i import eder ve o cagri yalnizca Next'in kendi
 * derleyicisi altinda cozulur -- Vitest'te render edilemez. Kabugun
 * erisilebilirlik iddialari (tek `main`, atlama baglantisi, landmark'lar) o
 * yuzden burada durur ve `test/ui/shell.test.tsx` bunlari gercekten calistirir.
 * `layout.tsx` fontlari takar ve bu bileseni cizer; baska is yapmaz.
 *
 * SIRA ONEMLI: atlama baglantisi ilk odaklanabilir ogedir. Basliktan sonra
 * gelirse, klavyeyle gezen biri onu bulana kadar zaten butun basligi gecmis
 * olur ve baglanti hicbir sey kazandirmaz.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <NetworkBanner />
      <Header />
      {/*
        `tabIndex={-1}`: atlama baglantisi tiklandiginda odak gercekten buraya
        gelmeli. Odaklanamayan bir hedefe atlamak yalnizca kaydirma yapar --
        Tab'a bir sonraki basista odak hâlâ basliktadir ve baglanti hicbir sey
        yapmamis olur.
      */}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-8 sm:px-6"
      >
        {children}
      </main>
      <Footer />
    </>
  )
}
