import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Same footprint as a listing card (4:3 photo, title, price, place), so nothing shifts on load. */
export function ListingCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Skeleton className="aspect-[4/3] w-full rounded-lg" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export function ListingGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <ListingCardSkeleton key={index} />
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6 py-8">
      <Skeleton className="h-9 w-2/3 max-w-md" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-5/6 max-w-xl" />
      <ListingGridSkeleton count={4} />
    </div>
  );
}
