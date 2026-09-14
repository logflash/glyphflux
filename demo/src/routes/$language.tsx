import { createFileRoute, redirect } from '@tanstack/react-router'
import { SdfApp } from '../SdfApp'
import { fontPreloadLinks, languageCodes } from '../catalog'

export const Route = createFileRoute('/$language')({
  beforeLoad: ({ params }) => {
    if (!languageCodes.has(params.language)) {
      throw redirect({ to: '/$language', params: { language: 'en' } })
    }
  },
  head: ({ params }) => ({
    meta: [{ title: `Glyphflux · ${params.language}` }],
    links: fontPreloadLinks(params.language),
  }),
  component: ControlledDemoRoute,
})

function ControlledDemoRoute() {
  const { language } = Route.useParams()
  const navigate = Route.useNavigate()
  return (
    <SdfApp
      initialLocale={language}
      onLocaleChange={(nextLanguage) =>
        void navigate({ to: '/$language', params: { language: nextLanguage } })
      }
    />
  )
}
