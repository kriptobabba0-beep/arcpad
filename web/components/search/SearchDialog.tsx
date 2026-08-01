'use client'

import { useRouter } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import type { SearchSortKey, TokenOverview } from '@/components/read/types'
import { Address } from '@/components/ui/Address'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import {
  SEARCH_AGE_LABELS,
  SEARCH_SORT_LABELS,
  searchRequestUrl,
  tokenHref,
  type SearchPayload,
  type SearchResponse,
} from './params'
import { SearchResultRow, UnindexedResultRow } from './SearchResultRow'
import { fromWire } from '@/components/read/wire'

/**
 * ⌘K MODALININ ICERIGI.
 *
 * Kisayolun KENDISI burada DEGIL: `<SearchTrigger>` acik/kapali durumu ve
 * ⌘K/Ctrl+K dinleyicisini tasir, bu bilesen yalnizca `open`/`onClose` alir.
 * Ikinci bir dinleyici yazmak, iki `preventDefault` ve iki durum makinesi
 * demek olurdu ve biri her zaman digerinden once curur.
 *
 * Odak tuzagi, Esc ve odak iadesi de burada DEGIL: `<Dialog>` onlari
 * uyguluyor. Bu dosyanin erisilebilirlik payi LISTBOX desenidir -- odak
 * GIRDIDE kalir, secim `aria-activedescendant` ile tasinir.
 */

/**
 * 250 ms. Olculen sey su: ortalama bir yazma hizinda (~200 ms/tus) daha kisa
 * bir pencere her hecede bir istek acar; daha uzun bir pencere ise yazmayi
 * bitirmis bir kullaniciya bekleme hissi verir.
 */
const DEBOUNCE_MS = 250

type View =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  /** `q` PAYLOAD'IN URETILDIGI sorgudur, girdideki guncel metin degil. */
  | { readonly status: 'ready'; readonly payload: SearchPayload; readonly q: string }

/** Bir secilebilir satir. `row === null` -> kanonik ama indekslenmemis adres. */
type Option = { readonly address: string; readonly row: TokenOverview | null }

export type SearchDialogProps = {
  open: boolean
  onClose: () => void
}

export function SearchDialog({ open, onClose }: SearchDialogProps) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SearchSortKey>('relevance')
  const [age, setAge] = useState('all')
  const [view, setView] = useState<View>({ status: 'idle' })
  const [active, setActive] = useState(0)

  const baseId = useId()
  const listboxId = `${baseId}-listbox`
  const inputWrapRef = useRef<HTMLDivElement | null>(null)

  const trimmed = q.trim()

  /**
   * ODAK GIRDIYE, ACILISTAN SONRA.
   *
   * `<Dialog>` acilista odagi PANELE aliyor (gerekcesi orada) ve bu efekt onu
   * gecersiz kilabiliyor cunku React efektleri COCUKTAN EBEVEYNE dogru kosar:
   * `Dialog` bu bilesenin cocugudur, dolayisiyla onun efekti once, bu efekt
   * sonra calisir. Sira tersine donseydi odak panelde kalir ve kullanici
   * yazmaya baslamak icin bir kez Tab'lamak zorunda kalirdi.
   *
   * `Input` bir ref iletmiyor ve ortak bir bilesenin API'sini tek bir cagiran
   * icin genisletmek yerine dugum DOM'dan aliniyor.
   */
  useEffect(() => {
    if (!open) return
    inputWrapRef.current?.querySelector('input')?.focus()
  }, [open])

  /**
   * KAPANISTA SORGU SIFIRLANIR.
   *
   * Son sorguyu saklamak "son bakilanlar" listesinin kucuk bir bicimidir ve
   * Adim 4 onu acikca kapsam disi birakti: paylasilan bir makinede ⌘K'ye
   * basan sonraki kisi, oncekinin ne aradigini gorurdu.
   */
  useEffect(() => {
    if (open) return
    setQ('')
    setView({ status: 'idle' })
  }, [open])

  /**
   * DEBOUNCE + IPTAL.
   *
   * `AbortController` bir optimizasyon degil BIR DOGRULUK KOSULU: iptal
   * olmadan iki istek yarisir ve GEC DONEN yanit, kullanicinin su an yazdigi
   * sorgunun sonuclarini ezer. Ekranda "ab" yazarken "a"nin sonuclarinin
   * durmasi, listedeki hicbir satirin girdiyle iliskisi olmadigi anlamina
   * gelir -- ve kullanici bunu anlamaz, yanlis token'a tiklar.
   *
   * Bu yuzden IKI kapi var: (a) `signal` fetch'e verilir, uctaki istek
   * gercekten iptal edilir; (b) `await`ten sonra `signal.aborted` yeniden
   * okunur, cunku yanit iptalden ONCE gelmis ama `setState` sirasi iptalden
   * SONRAYA dusmus olabilir.
   */
  useEffect(() => {
    if (!open) return
    if (trimmed === '') {
      setView({ status: 'idle' })
      return
    }

    setView({ status: 'loading' })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(searchRequestUrl({ q: trimmed, sort, age }), {
            signal: controller.signal,
          })
          const body = (await response.json()) as SearchResponse
          if (controller.signal.aborted) return
          setView(
            'error' in body ? { status: 'error' } : { status: 'ready', payload: body, q: trimmed },
          )
        } catch {
          // Iptal edilen bir istek bir HATA DEGILDIR ve ekrana bir hata
          // yazmaz: kullanici yazmaya devam ediyor, yeni istek yolda.
          if (controller.signal.aborted) return
          setView({ status: 'error' })
        }
      })()
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, trimmed, sort, age])

  /**
   * RET, HER SEYDEN ONCE.
   *
   * `refused` hukmunde sunucu zaten satir gondermiyor (bkz. route.ts). Buradaki
   * kontrol o garantinin IKINCI kopyasidir ve bilincli: istemci, hukum "ret"
   * ise govdede ne gelirse gelsin onu bir launch gibi CIZMEZ. Iki bagimsiz
   * kapinin ayni anda acilmasi gerekir ki bir sahte adres gercek bir launch
   * gibi gorunsun.
   */
  const options: readonly Option[] = useMemo(() => {
    if (view.status !== 'ready') return []
    const pasted = view.payload.pasted
    if (pasted?.kind === 'refused') return []
    if (pasted?.kind === 'notIndexed') return [{ address: pasted.address, row: null }]
    return view.payload.rows.map((wire) => {
      const row = fromWire(wire)
      return { address: row.token, row }
    })
  }, [view])

  // Yeni bir sonuc kumesi geldiginde secim BASA doner: onceki listenin
  // ucuncu satirindaki secimi yeni listede tutmak, kullanicinin hic
  // bakmadigi bir token'a Enter bastirir.
  useEffect(() => {
    setActive(0)
  }, [options])

  const optionId = useCallback((index: number) => `${baseId}-option-${index}`, [baseId])

  const select = useCallback(
    (option: Option) => {
      onClose()
      router.push(tokenHref(option.address))
    },
    [onClose, router],
  )

  /**
   * LISTBOX KLAVYE DESENI. Odak girdide kalir; bu tuslar girdide yakalanir.
   *
   * Esc BURADA YOK ve olmamali: `<Dialog>` onu kendi kapsayicisinda dinliyor
   * ve olay oraya kabarciklaniyor. Ikinci bir Esc dali, modalin kapanmasini
   * iki ayri kod yoluna bagimli kilardi.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const count = options.length
      if (count === 0) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        // Uclarda SARILIR: yirmi satirlik bir listede sona gelip yukari
        // donmek, "ilk sonuca don" icin yirmi tusa mal olur.
        setActive((index) => (index + 1) % count)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + count) % count)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        setActive(0)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        setActive(count - 1)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const option = options[active]
        if (option) select(option)
      }
    },
    [active, options, select],
  )

  const activeOptionId = options.length > 0 && options[active] ? optionId(active) : null
  const announcement = announce(view)

  return (
    <Dialog open={open} onClose={onClose} title="Search" size="lg" className="max-w-2xl">
      <div className="flex flex-col gap-3">
        <div ref={inputWrapRef}>
          <Input
            label="Search tokens"
            hideLabel
            role="combobox"
            aria-expanded={options.length > 0}
            aria-autocomplete="list"
            {...(options.length > 0 ? { 'aria-controls': listboxId } : {})}
            {...(activeOptionId === null ? {} : { 'aria-activedescendant': activeOptionId })}
            placeholder="Name, symbol, or paste a token address"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={onKeyDown}
            // Tarayicinin kendi oneri katmani listbox'in ustune biner ve
            // `aria-activedescendant`la yaristigi icin kapatiliyor.
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {SEARCH_SORT_LABELS.map(({ key, label }) => {
            // `relevance` YALNIZCA `q` doluyken etkin: bos bir sorguda
            // siralanacak bir "alaka" yoktur. Gizlemek yerine devre disi
            // birakiliyor -- serit sabit kalir, yani kullanicinin gozu her
            // yazista yeniden yerlesmek zorunda kalmaz.
            const disabled = key === 'relevance' && trimmed === ''
            return (
              <Button
                key={key}
                pill
                size="sm"
                variant={sort === key ? 'primary' : 'ghost'}
                aria-pressed={sort === key}
                disabled={disabled}
                onClick={() => setSort(key)}
              >
                {label}
              </Button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] uppercase tracking-[0.08em] text-muted">Age</span>
          {SEARCH_AGE_LABELS.map(({ value, label }) => (
            <Button
              key={value}
              pill
              size="sm"
              variant={age === value ? 'primary' : 'ghost'}
              aria-pressed={age === value}
              onClick={() => setAge(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        {/*
          Sonuc sayisi DUYURULUR. Gorsel bir listede sayiyi gormek bedava;
          ekran okuyucuda, duyurulmazsa hic yoktur.

          `data-testid` var cunku bu sayfada `role="status"` TEKIL DEGIL:
          her `<Address>` kendi kopyalama onayi icin bir tane daha aciyor.
          Rolle secmek, satir sayisi degistikce anlami degisen bir sorgu
          olurdu.
        */}
        <p role="status" aria-live="polite" data-testid="search-announcement" className="sr-only">
          {announcement}
        </p>

        <div className="max-h-[46vh] min-h-[8rem] overflow-y-auto">
          <Body
            view={view}
            options={options}
            active={active}
            listboxId={listboxId}
            optionId={optionId}
            onHover={setActive}
            onSelect={select}
          />
        </div>
      </div>
    </Dialog>
  )
}

/** `aria-live` metni. Sayilar `en-US` ile bicimlenir (depo kurali). */
function announce(view: View): string {
  if (view.status === 'idle') return ''
  if (view.status === 'loading') return 'Searching'
  if (view.status === 'error') return 'Search is unavailable'
  const pasted = view.payload.pasted
  if (pasted?.kind === 'refused') return 'This address is not an arcpad launch.'
  if (pasted?.kind === 'notIndexed') return '1 result, not indexed yet'
  // "N sonuc" DEGIL "N gosteriliyor" -- devaminda sayfa varsa toplam bunun
  // uzerindedir ve toplami bilmiyoruz. Duyuru bildigimiz seyi soyler.
  const shown = view.payload.shown
  const more = view.payload.nextCursor !== null
  const noun = shown === 1 ? 'result' : 'results'
  return more
    ? `${shown.toLocaleString('en-US')} ${noun} shown, more available`
    : `${shown.toLocaleString('en-US')} ${noun}`
}

function Body({
  view,
  options,
  active,
  listboxId,
  optionId,
  onHover,
  onSelect,
}: {
  view: View
  options: readonly Option[]
  active: number
  listboxId: string
  optionId: (index: number) => string
  onHover: (index: number) => void
  onSelect: (option: Option) => void
}) {
  if (view.status === 'idle') {
    /*
     * BOS SORGUDA "SON BAKILANLAR" GOSTERILMEZ.
     *
     * Yerel bir gecmis tutmak bu fazin kapsami degil, ve kapsam disi olmasi
     * bir eksiklik degil bir karar: paylasilan bir makinede modali acan
     * sonraki kisi, oncekinin hangi token'lara baktigini gorurdu.
     */
    return <Note>Type to search by name, symbol, or paste a token address.</Note>
  }

  if (view.status === 'loading') {
    return (
      <div className="flex flex-col gap-2 py-1" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (view.status === 'error') {
    /*
     * VERITABANI DUSTUGUNDE MODAL YINE KAPANIR.
     *
     * Bugun BU dal canli yoldur: `components/read/boundary.ts` her okumaya
     * `unavailable` donuyor cunku Faz 3'un `queries.ts`'i depoda yok. Yani
     * asagidaki metin bir gelecek vaadi degil, su anda ekranda gorunen sey.
     */
    return (
      <Note>
        <span className="text-text">Search is unavailable right now.</span> The index could not be
        reached. Trading and launching still work — close this and use the token page.
      </Note>
    )
  }

  const pasted = view.payload.pasted

  if (pasted?.kind === 'refused') {
    return (
      <div
        data-canonicity={pasted.canonicity}
        className="rounded-card border border-negative/30 bg-negative/8 px-4 py-3"
      >
        {/* BU CUMLE BIREBIR: hukum bir uyari degil bir REDDIR. */}
        <p className="text-sm font-medium text-text">This address is not an arcpad launch.</p>
        <p className="mt-1.5 text-[13px] text-muted">
          <Address value={pasted.address} label="Pasted address" /> could not be derived from
          arcpad&rsquo;s own launch data.
        </p>
        {/* Isim, sembol ve gorsel BILEREK yok -- sunucu onlari hic okumadi. */}
        <p className="mt-2 text-[12px] leading-snug text-muted">
          Nothing else about this address is shown. A forged token can copy a real launch&rsquo;s
          name, symbol, image, creator and price; the address is the one thing it cannot copy.
        </p>
      </div>
    )
  }

  if (options.length === 0) {
    return <Note>{`No tokens match “${view.q}”.`}</Note>
  }

  const shown = options.length
  // Devami VAR MI sorusuna cevap `nextCursor`; KACINCI sorusuna cevabimiz yok
  // (Faz 3 toplam vermiyor). Bilinmeyen bir toplami yazmak yerine, devami
  // oldugu yaziliyor.
  const hasMore = pasted === null && view.payload.nextCursor !== null

  return (
    <>
      <ul
        role="listbox"
        id={listboxId}
        aria-label="Search results"
        className="flex flex-col gap-0.5"
      >
        {options.map((option, index) =>
          option.row === null ? (
            <UnindexedResultRow
              key={option.address}
              address={option.address}
              id={optionId(index)}
              selected={index === active}
              onHover={() => onHover(index)}
              onSelect={() => onSelect(option)}
            />
          ) : (
            <SearchResultRow
              key={option.address}
              row={option.row}
              id={optionId(index)}
              selected={index === active}
              onHover={() => onHover(index)}
              onSelect={() => onSelect(option)}
            />
          ),
        )}
      </ul>

      {/*
        SAYFALAMA YOK, ve olmadigi soyleniyor.

        Plan bu modal icin Task 8'in `<KeysetPager>`'ini isaretliyor; o bilesen
        depoda henuz yok. `nextCursor` yanitta TASINIYOR (rota `?after=` kabul
        ediyor), yani pager indiginde baglanacak tek yer burasi. O gune kadar
        sessizce ilk sayfayi gostermek yerine, kacinin gosterildigi yaziliyor.
      */}
      {hasMore ? (
        <p className="px-2.5 pt-2 text-[12px] text-muted">
          {`Showing the first ${shown.toLocaleString('en-US')} — refine the query to narrow it down.`}
        </p>
      ) : null}
    </>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 py-6 text-center text-[13px] leading-relaxed text-muted">{children}</p>
  )
}
