import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ViewTransitionDemo } from '../ViewTransitionDemo'
import { fontPreloadLinks, languageCodes } from '../catalog'

export const Route = createFileRoute('/$language_/view/$style')({
  beforeLoad: ({ params }) => {
    if (!languageCodes.has(params.language) || !['sans', 'serif'].includes(params.style)) {
      throw redirect({ to: '/$language', params: { language: 'en' } })
    }
  },
  head: ({ params }) => ({
    meta: [{ title: `Glyphflux view transition · ${params.language}` }],
    links: fontPreloadLinks(params.language),
  }),
  component: ViewTransitionRoute,
})

function ViewTransitionRoute() {
  const params = Route.useParams()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const otherStyle = params.style === 'sans' ? 'serif' : 'sans'

  useEffect(() => {
    void router
      .preloadRoute({
        to: '/$language/view/$style',
        params: { language: params.language, style: otherStyle },
      })
      .catch(() => undefined)
  }, [otherStyle, params.language, router])

  return (
    <ViewTransitionDemo
      locale={params.language}
      fontRole={params.style as 'sans' | 'serif'}
      onNavigate={(fontRole) =>
        void navigate({
          to: '/$language/view/$style',
          params: { language: params.language, style: fontRole },
        })
      }
      onLocaleChange={(language) =>
        void navigate({
          to: '/$language/view/$style',
          params: { language, style: params.style },
        })
      }
    />
  )
}

