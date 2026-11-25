import StatusScreen from '@/app/components/StatusScreen'

// Every address that matches no page, and every notFound(): one screen in our
// own look instead of Next's default (app/components/StatusScreen.tsx).
export const metadata = { title: 'Page not found · TravelDesk' }

export default function NotFound() {
  return (
    <StatusScreen
      kind="not-found"
      fullScreen
      title="We couldn't find that page"
      message="The address may be mistyped, or the page has moved. Your trips and bookings are not affected."
    />
  )
}
