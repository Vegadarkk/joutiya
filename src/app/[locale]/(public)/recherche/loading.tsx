import { SearchResultsSkeleton } from "@/components/search/search-skeleton";

// Shown while a search renders after a navigation from another page (breadcrumb, header search).
export default function SearchLoading() {
  return <SearchResultsSkeleton />;
}
