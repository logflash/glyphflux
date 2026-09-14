import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { fontFaceCss } from '../catalog'
import { refreshFrameBootstrap } from '../refreshFrame'
import '../../../styles.css'
import '../styles.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      {
        name: 'description',
        content: 'Glyphflux morphs the same text smoothly between different fonts.',
      },
    ],
    links: [{ rel: 'icon', href: 'data:,' }],
  }),
  shellComponent: RootDocument,
  component: Outlet,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style data-glyphflux-font-faces>{fontFaceCss}</style>
        <HeadContent />
      </head>
      <body>
        {children}
        <script>{refreshFrameBootstrap}</script>
        <Scripts />
      </body>
    </html>
  )
}
