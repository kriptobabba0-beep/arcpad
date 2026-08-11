'use client'

import { METADATA_LIMITS } from '@arcpad/shared/browser'
import { useCallback, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ByteCounter } from './ByteCounter'
import type { LaunchFields } from './fields'

/**
 * METADATA -- UC YOL, VE UCU DE LAUNCH'A CIKAR.
 *
 *   1. YUKLEME  : pinning yapilandirilmissa. Dosya + alanlar `/api/metadata`'ya
 *                 gider, `ipfs://…` doner.
 *   2. URI      : kullanici kendi URI'sini yapistirir. Pinning'e hic ihtiyaci
 *                 yoktur ve HER KURULUMDA calisir.
 *   3. URI'SIZ  : `uri` bos dize olarak gider. `LaunchFactory.launch` yalnizca
 *                 isim ve sembolun bos olmamasini ister.
 *
 * PINNING YAPILANDIRILMAMISLIGI BIR HATA GIBI CIZILMEZ. Kirmizi bir kutu,
 * kullaniciya urunun bozuk oldugunu soyler; oysa urun o kurulumda boyle
 * calisir ve elinde iki yol daha vardir.
 */

export type MetadataUploadProps = {
  /** Sunucunun istek aninda okudugu deger. Rota 501 donerse istemci de duser. */
  pinningConfigured: boolean
  fields: LaunchFields
  onPatch: (patch: Partial<LaunchFields>) => void
  disabled?: boolean
}

type UploadState =
  { kind: 'idle' } | { kind: 'uploading' } | { kind: 'done' } | { kind: 'failed'; message: string }

export function MetadataUpload({
  pinningConfigured,
  fields,
  onPatch,
  disabled = false,
}: MetadataUploadProps) {
  const [consented, setConsented] = useState(false)
  const [pinningAvailable, setPinningAvailable] = useState(pinningConfigured)
  const [upload, setUpload] = useState<UploadState>({ kind: 'idle' })
  const [noArtwork, setNoArtwork] = useState(false)
  // DOSYA STATE'TE TUTULUR, yalnizca `<input>`te degil. Yukleme dustugunde
  // kullanicinin dosyayi YENIDEN SECMESI gerekmemeli: en can sikici hata,
  // kullaniciyi yaptigi isi tekrarlamaya zorlayan hatadir.
  const [file, setFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const consentId = useId()
  const fileId = useId()
  const noArtworkId = useId()

  const send = useCallback(
    async (chosen: File | null) => {
      setUpload({ kind: 'uploading' })
      const body = new FormData()
      body.append(
        'fields',
        JSON.stringify({
          name: fields.name,
          symbol: fields.symbol,
          description: fields.description,
          x: fields.x,
          telegram: fields.telegram,
        }),
      )
      if (chosen) body.append('image', chosen, chosen.name)

      let response: Response
      try {
        response = await fetch('/api/metadata', { method: 'POST', body })
      } catch {
        setUpload({ kind: 'failed', message: 'The upload did not reach the server.' })
        return
      }

      if (response.status === 501) {
        // SUNUCU SOYLEDI: pinning yok. Istemci de o yola duser ve bunu bir
        // hata olarak DEGIL, bir aciklama olarak gosterir.
        setPinningAvailable(false)
        setUpload({ kind: 'idle' })
        return
      }
      if (!response.ok) {
        setUpload({
          kind: 'failed',
          message:
            response.status === 413
              ? 'That image is larger than 5 MB.'
              : response.status === 415
                ? 'That file type is not accepted. Use PNG, JPEG, GIF or WebP.'
                : 'The upload failed. Your file is still selected — try again.',
        })
        return
      }

      const payload = (await response.json()) as { uri?: unknown; image?: unknown }
      if (typeof payload.uri !== 'string') {
        setUpload({ kind: 'failed', message: 'The server answered without a URI.' })
        return
      }
      onPatch({
        uri: payload.uri,
        ...(typeof payload.image === 'string' ? { image: payload.image } : {}),
      })
      setUpload({ kind: 'done' })
    },
    [fields.name, fields.symbol, fields.description, fields.x, fields.telegram, onPatch],
  )

  const locked = disabled || noArtwork

  return (
    <div className="flex flex-col gap-4">
      {pinningAvailable ? (
        <div className="flex flex-col gap-3">
          {/*
            ONAY KUTUSU DOSYA SECIMININ ONUNDEDIR, yanindaki bir uyari degil.
            IPFS'e pinlenen bir dosya SILINEMEZ: baska bir dugum onu kopyalamis
            olabilir ve CID onu adresler. Bunu dosya secildikten SONRA soylemek,
            geri alinamayan bir islemi haber vermeden yaptirmak olurdu.
          */}
          <label htmlFor={consentId} className="flex items-start gap-2 text-[13px] leading-snug">
            <input
              id={consentId}
              type="checkbox"
              checked={consented}
              disabled={locked}
              onChange={(event) => setConsented(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span>I understand the artwork is uploaded to public IPFS and cannot be removed.</span>
          </label>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={fileId} className="text-[13px] font-medium text-muted">
              Artwork
            </label>
            <input
              id={fileId}
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              disabled={!consented || locked || upload.kind === 'uploading'}
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null
                setFile(chosen)
                if (chosen) void send(chosen)
              }}
              className="text-[13px] text-muted file:mr-3 file:rounded-input file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-text disabled:opacity-45"
            />
            {/*
              SECILEN GORSEL KALDIRILABILIR OLMALI.

              Onceki hal yalnizca dosya ADINI yaziyordu ve geri donusu yoktu:
              yanlis gorseli secen biri onu kaldiramiyordu. Tarayicinin kendi
              dosya secicisi yeni bir secimle uzerine yazmaya izin verir, ama
              SIFIRLAMAYA izin vermez -- ve pinlenmis URI formda kalmaya devam
              ederdi, yani kullanici zincire YANLIS gorseli yazardi.

              `input.value = ''` sart: aksi halde AYNI dosya ikinci kez
              secildiginde `change` olayi hic atesmez (tarayici degeri ayni
              gorur) ve kaldirdiktan sonra ayni gorseli geri koymak imkansiz
              olurdu.
            */}
            {file ? (
              <div className="flex items-center gap-2 rounded-input border border-border bg-surface-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-text">{file.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setFile(null)
                    setUpload({ kind: 'idle' })
                    if (inputRef.current !== null) inputRef.current.value = ''
                    // Pinlenmis URI de DUSER: gorsel kaldirildiysa onu
                    // gosteren adres de kalmamali.
                    onPatch({ uri: '', image: '' })
                  }}
                  aria-label={`Remove ${file.name}`}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-white/10 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M1 1l10 10M11 1L1 11"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ) : null}
          </div>

          {upload.kind === 'uploading' ? (
            <p role="status" className="text-[12px] text-muted">
              Uploading…
            </p>
          ) : null}
          {upload.kind === 'done' ? (
            <p role="status" className="text-[12px] text-accent">
              Pinned. The URI below is what goes on chain.
            </p>
          ) : null}
          {upload.kind === 'failed' ? (
            <div className="flex items-center gap-3">
              <p role="alert" className="text-[12px] text-negative">
                {upload.message}
              </p>
              <Button size="sm" onClick={() => void send(file)} disabled={locked}>
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        /*
          Pinning yoksa cizilen sey bir hata degil bir ACIKLAMADIR ve `role`
          tasimaz: ekran okuyucuya duyurulacak bir olay yok, okunacak bir metin
          var.
        */
        <p
          data-testid="pinning-unconfigured"
          className="rounded-card border border-border bg-surface-2 px-3 py-2 text-[12px] leading-snug text-muted"
        >
          Uploads are not set up on this deployment, so artwork is pasted rather than uploaded. Pin
          your metadata JSON anywhere you like and paste its URI below — launching works exactly the
          same.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Input
          label="Metadata URI"
          placeholder="ipfs://…"
          value={fields.uri}
          disabled={locked}
          onChange={(event) => onPatch({ uri: event.target.value })}
          hint="This goes on chain and can never be changed."
        />
        <ByteCounter value={fields.uri} maxBytes={METADATA_LIMITS.uri} />
      </div>

      {/*
        "URI'siz launch" bir kolaylik degil DURUSTLUKTUR. `metadataURI` alani
        `immutable` DEGILDIR ama onu degistiren bir FONKSIYON YOKTUR -- yani
        sonradan eklemek diye bir sey yok ve kullanici bunu secmeden once
        bilmeli.
      */}
      <label htmlFor={noArtworkId} className="flex items-start gap-2 text-[13px] leading-snug">
        <input
          id={noArtworkId}
          type="checkbox"
          checked={noArtwork}
          disabled={disabled}
          onChange={(event) => {
            setNoArtwork(event.target.checked)
            if (event.target.checked) {
              setFile(null)
              setUpload({ kind: 'idle' })
              if (inputRef.current) inputRef.current.value = ''
              onPatch({ uri: '', image: '' })
            }
          }}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
        />
        <span>Launch without artwork — you cannot add it later.</span>
      </label>
    </div>
  )
}
