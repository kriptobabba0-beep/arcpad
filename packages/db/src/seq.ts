/**
 * Bir blogun tasiyabilecegi log sayisinin USTUNDEKI en kucuk iki kuvveti
 * secmenin turetmesi: Arc blok gaz limiti OLCULDU, gasLimit = 0x1c9c380 =
 * 30.000.000. En ucuz log opcode'u LOG0'dir ve taban maliyeti 375 gazdir,
 * yani bir blokta en fazla 30.000.000 / 375 = 80.000 log olabilir.
 * 2^20 = 1.048.576, bu tavanin 13 kati.
 *
 * Ust taraf: bigint tavani 9.223.372.036.854.775.807; 2^20'ye bolundugunde
 * 8.796.093.022.207 blok kalir. 350ms blok suresiyle ~97.600 yil.
 */
export const LOG_INDEX_BITS = 20n
export const MAX_LOG_INDEX = 1_048_575

/** `toSeq`'in uretebilecegi en buyuk deger; tam olarak Postgres `bigint` tavani. */
export const MAX_SEQ = 9_223_372_036_854_775_807n

/** `MAX_SEQ`'i asmayan en buyuk blok numarasi: 2^43 - 1. */
export const MAX_BLOCK_NUMBER = 8_796_093_022_207n

export function toSeq(blockNumber: bigint, logIndex: number): bigint {
  if (blockNumber < 0n) throw new RangeError('toSeq: blockNumber negatif')
  if (!Number.isInteger(logIndex) || logIndex < 0 || logIndex > MAX_LOG_INDEX) {
    // SESSIZ CAKISMAYI onleyen tek kontrol bu. logIndex tavani asarsa
    // kodlama BIR SONRAKI blogun alanina tasar ve iki ayri olay AYNI
    // event_seq'i alir -- yani ON CONFLICT DO NOTHING birini sessizce yutar.
    throw new RangeError(`toSeq: logIndex ${logIndex} araligin disinda`)
  }
  return (blockNumber << LOG_INDEX_BITS) | BigInt(logIndex)
}

export function fromSeq(seq: bigint): { blockNumber: bigint; logIndex: number } {
  return {
    blockNumber: seq >> LOG_INDEX_BITS,
    logIndex: Number(seq & ((1n << LOG_INDEX_BITS) - 1n)),
  }
}
