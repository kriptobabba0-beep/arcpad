import { arcTestnet } from '@arcpad/shared'
import { createConfig, http } from 'wagmi'

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http(),
  },
  ssr: true,
})
