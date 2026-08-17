'use client'

import { SearchDialog } from '@/components/search/SearchDialog'
import { SearchTrigger } from './SearchTrigger'

/**
 * TETIKLEYICI ILE MODALI BIRLESTIREN ISTEMCI SINIRI.
 *
 * `Header` bir SERVER component ve `SearchTrigger` bir client component. Bir
 * server component'ten client component'e FONKSIYON PROP GECIRILEMEZ -- yani
 * `renderDialog={({open}) => <SearchDialog … />}` dogrudan `Header` icinde
 * yazilamaz; Next onu serilestiremez.
 *
 * Bu dosya o siniri kapatir: burada her sey istemcidir, dolayisiyla render
 * prop'u mesrudur. `Header` yalnizca `<SearchBar />` cizer.
 *
 * Alternatif `SearchTrigger`'in `SearchDialog`'u DOGRUDAN import etmesiydi.
 * Reddedildi: kabugun arama modaline -- ve onun uzerinden veritabanina ve
 * `verifyCanonical`'a -- bagimli olmasi demek olurdu. Ayrimin sebebi buydu ve
 * duruyor.
 */
export function SearchBar() {
  return (
    <SearchTrigger
      renderDialog={({ open, onClose }) => <SearchDialog open={open} onClose={onClose} />}
    />
  )
}
