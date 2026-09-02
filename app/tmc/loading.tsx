import { SkeletonHeader, SkeletonTiles, SkeletonTable } from '@/app/components/Skeleton'

// Next renders this instantly during the route transition, before the page
// component mounts and starts fetching. The rail is already painted by the
// layout above, so navigation now shows shell + content-shaped placeholders
// immediately instead of a blank panel followed by a spinner.
export default function TmcLoading() {
  return (
    <div className="px-8 py-7">
      <SkeletonHeader />
      <SkeletonTiles />
      <div className="mt-4">
        <SkeletonTable rows={5} cols={6} />
      </div>
    </div>
  )
}
