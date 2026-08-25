/**
 * Molecule and reaction depiction, drawn in the browser from SMILES.
 *
 * SmilesDrawer renders by mutating an `<svg>` element, so drawing happens in an
 * effect rather than during render. Two things matter for a route tree, where
 * the same building block appears many times:
 *
 * - depictions are cached by (smiles, theme, size), so a repeated molecule is
 *   drawn once and cloned afterwards;
 * - a SMILES that will not parse degrades to its text, never to an empty box.
 *   Models do emit unparsable SMILES, and a blank card hides that fact.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import SmilesDrawer from 'smiles-drawer'

export type Theme = 'light' | 'dark'

/** Bounded depiction cache: SVG markup keyed by what determines it. */
const DEPICTIONS = new Map<string, string>()
const DEPICTION_CACHE_LIMIT = 400

function cacheKey(smiles: string, theme: Theme, width: number, height: number): string {
  return `${theme}|${width}x${height}|${smiles}`
}

function remember(key: string, markup: string): void {
  if (DEPICTIONS.size >= DEPICTION_CACHE_LIMIT) {
    const oldest = DEPICTIONS.keys().next().value
    if (oldest !== undefined) DEPICTIONS.delete(oldest)
  }
  DEPICTIONS.set(key, markup)
}

/** Exposed so tests can start from a known state. */
export function clearDepictionCache(): void {
  DEPICTIONS.clear()
}

/** Follow the viewer's colour scheme, since depictions are drawn, not styled. */
export function useTheme(): Theme {
  const read = (): Theme => {
    if (typeof document === 'undefined') return 'light'
    const declared = document.documentElement.dataset['theme']
    if (declared === 'dark' || declared === 'light') return declared
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  const [theme, setTheme] = useState<Theme>(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (): void => setTheme(read())
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])
  return theme
}

export interface StructureProps {
  /** A molecule SMILES, or a reaction SMILES containing `>>`. */
  smiles: string
  theme: Theme
  width?: number
  height?: number
  /** Accessible label; defaults to the SMILES itself. */
  title?: string
}

/**
 * One depicted structure.
 *
 * A reaction SMILES (`A.B>>C`) is handed to SmilesDrawer whole, so the arrow and
 * both sides are laid out together rather than assembled from separate images.
 */
export function Structure(props: StructureProps): ReactElement {
  const { smiles, theme, width = 180, height = 120 } = props
  const host = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const container = host.current
    if (container === null) return
    let cancelled = false
    const key = cacheKey(smiles, theme, width, height)

    const cached = DEPICTIONS.get(key)
    if (cached !== undefined) {
      container.innerHTML = cached
      setFailed(false)
      return
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    container.replaceChildren(svg)

    try {
      const drawer = new SmilesDrawer.SmiDrawer(
        { width, height, padding: 4, compactDrawing: false, terminalCarbons: true },
        { scale: 1 },
      )
      drawer.draw(
        smiles,
        svg,
        theme,
        () => {
          if (cancelled) return
          remember(key, container.innerHTML)
          setFailed(false)
        },
        () => { if (!cancelled) setFailed(true) },
      )
    } catch {
      // Any depiction failure is a display problem, never a crash: the SMILES
      // is shown as text instead, which is still usable information.
      if (!cancelled) setFailed(true)
    }
    return () => { cancelled = true }
  }, [smiles, theme, width, height])

  if (failed) {
    return (
      <code
        title={props.title ?? smiles}
        style={{
          display: 'inline-block', maxWidth: width, overflowWrap: 'anywhere',
          fontSize: 11, opacity: 0.85, padding: '2px 4px',
        }}
      >
        {smiles}
      </code>
    )
  }

  return (
    <div
      ref={host}
      title={props.title ?? smiles}
      aria-label={props.title ?? smiles}
      style={{ width, height, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    />
  )
}
