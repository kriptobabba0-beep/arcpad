/**
 * ============ ALARM LAVABOSUNUN SATIRLARINI KAYITLARA AYIRMAK ============
 *
 * `fileSink` `renderEvent`in TEK bicimini yazar:
 *
 *   PAGE|OK|HEARTBEAT <bilesen> at=<ISO> <geri kalan>
 *
 * ...ama "geri kalan" COK SATIRLI OLABILIR. Olculdu, uydurulmadi: canli
 * `keeper/alerts.log` ve `keeper/graduate.log` icinde viem'in hata metni
 * (`URL:`, `Request body:`, `Details:`) kendi satir sonlarini tasiyor -- tek
 * bir `PAGE` olayi dosyada YEDI satir.
 *
 * `drill.ts` bu devam satirlarini DUSURUR ve bu onun icin dogrudur: o yalnizca
 * "bu pencerede bir sayfa var miydi" diye sorar. Bir ILETICI icin ayni davranis
 * yanlis olurdu -- pager'a sayfanin govdesi degil yalnizca ilk satiri giderdi.
 * Bu yuzden burada kayit = BASLIK SATIRI + bir sonraki basliga kadar her sey.
 */

export type RecordKind = 'page' | 'ok' | 'heartbeat'

export type NotifyRecord = {
  kind: RecordKind
  component: string
  /** `null` = damga ayristirilamadi. Tazelik suzgeci bunu DUSURMEZ; bkz. `forwarder.ts`. */
  atMs: number | null
  /** Baslik satiri + devam satirlari, satir sonlariyla birlikte. */
  text: string
}

const HEADER = /^(PAGE|OK|HEARTBEAT) (\S+) at=(\S+)/

function headerOf(line: string): NotifyRecord | undefined {
  const m = HEADER.exec(line)
  if (m === null) return undefined
  const at = Date.parse(m[3] as string)
  return {
    kind: m[1] === 'PAGE' ? 'page' : m[1] === 'OK' ? 'ok' : 'heartbeat',
    component: m[2] as string,
    atMs: Number.isNaN(at) ? null : at,
    text: line,
  }
}

/**
 * TAMPONU KAYITLARA BOLER, VE YARIM YAZILMIS SONUNCUYU TAMPONDA BIRAKIR.
 *
 * TAMLIK OLCUTU SON KARAKTERIN `\n` OLMASIDIR, bir zamanlayici DEGIL.
 * `fileSink` her olayi TEK bir `appendFileSync(path, text + '\n')` ile yazar,
 * dolayisiyla sonu satir sonuyla biten bir tampon, o ana kadar yazilmis her
 * olayin TAMAMINI icerir. Sonu satir sonuyla bitmeyen bir tampon YAZMANIN
 * ORTASINDA okundu demektir ve son kaydi tutmak, pager'a yarim bir sayfa
 * gondermekten iyidir.
 *
 * KABUL EDILEN SINIR, VE ADIYLA YAZILIYOR: cok satirli bir olayin yazimi
 * gercekten ikiye bolunur ve ilk yari satir sonuyla biterse, kayit ERKEN
 * yayilir ve kalan devam satirlari BASLIKSIZ kalip DUSER. O durumda bile
 * sayfanin BIRINCI satiri -- siniflandirma, hedef ve maruziyet oradadir --
 * eksiksiz gider; kaybolan sey viem'in ek metnidir.
 */
export function drainRecords(buffer: string): { records: NotifyRecord[]; rest: string } {
  if (buffer === '') return { records: [], rest: '' }

  // YARIM SATIR HER ZAMAN TUTULUR, BASLIGA BENZESIN YA DA BENZEMESIN.
  // Onceki hali yalnizca "son kayit" tutuyordu ve `PAG` gibi yarim yazilmis
  // bir BASLIGI baslik saymadigi icin dusururdu -- yani tam da korunmasi
  // gereken sey, tek bir bolunmus okumada sessizce kaybolurdu.
  const nl = buffer.lastIndexOf('\n')
  if (nl === -1) return { records: [], rest: buffer }
  const head = buffer.slice(0, nl + 1)
  const tail = buffer.slice(nl + 1)

  const records: NotifyRecord[] = []
  let current: NotifyRecord | undefined
  for (const line of head.split(/\r?\n/).slice(0, -1)) {
    const header = headerOf(line)
    if (header !== undefined) {
      if (current !== undefined) records.push(current)
      current = header
      continue
    }
    // BASLIKSIZ ONEK DUSER. Buraya ancak tamponun BASINDA, yani basligi bir
    // onceki turda zaten yayilmis bir kaydin kuyrugunda gelinebilir.
    if (current === undefined) continue
    current.text += `\n${line}`
  }
  if (current !== undefined) records.push(current)

  // Dosya satir sonuyla BITMIYORSA son kayit hala BUYUYOR olabilir: yarim
  // satir onun bir devami olabilir. Onu geri tamponun icine koy.
  if (tail !== '') {
    const held = records.pop()
    return { records, rest: held === undefined ? tail : `${held.text}\n${tail}` }
  }
  return { records, rest: '' }
}
