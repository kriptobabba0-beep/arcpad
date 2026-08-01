import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button, buttonClassName } from '@/components/ui/Button'

/**
 * KONTRAST KAPISINI BUTONA BAGLAYAN TEST.
 *
 * `contrast.test.ts` bir TOKEN CIFTINI olcer: `--color-primary-fg` uzerinde
 * `--color-primary`, 5,49:1. Ama o tek basina birincil butonun O tokenlari
 * kullandigini soylemez -- biri `text-text` yazsaydi CSS kapisi yesil kalir,
 * ekrandaki buton 3,59:1'e duserdi.
 *
 * Bu test o boslugu kapatir: buton, kapinin olctugu tokenlarin TA KENDILERINI
 * tasimak zorunda.
 */
describe('<Button variant="primary">', () => {
  it('kontrast kapisinin olctugu tokenlari tasir', () => {
    render(<Button variant="primary">Connect wallet</Button>)
    const classes = screen.getByRole('button', { name: 'Connect wallet' }).className.split(/\s+/)

    expect(classes).toContain('bg-primary')
    expect(classes).toContain('text-primary-fg')
    expect(classes).toContain('hover:bg-primary-hover')
  })

  it('acik bir metin tokeni TASIMAZ', () => {
    // Mutant: metni `#FAFAFA` yapmak. Tailwind'de bunun karsiligi `text-text`
    // ya da `text-white`; ikisi de burada kirmizi.
    const classes = buttonClassName({ variant: 'primary' }).split(/\s+/)
    expect(classes).not.toContain('text-text')
    expect(classes).not.toContain('text-white')
  })

  it('varsayilan type "button" -- form icindeki bir susleme formu gondermez', () => {
    render(<Button>Cancel</Button>)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button')
  })

  it('type acikca verilebilir', () => {
    render(<Button type="submit">Launch token</Button>)
    expect(screen.getByRole('button', { name: 'Launch token' })).toHaveAttribute('type', 'submit')
  })

  it('pill varyanti --radius-pill kullanir', () => {
    expect(buttonClassName({ pill: true })).toContain('rounded-pill')
    expect(buttonClassName({})).toContain('rounded-input')
  })

  it('devre disi buton isaret ALMAZ ve tiklanamaz', () => {
    render(
      <Button disabled variant="primary">
        Switch to Arc Testnet
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Switch to Arc Testnet' })
    expect(button).toBeDisabled()
    expect(button.className).toContain('disabled:pointer-events-none')
  })
})
