import { useQuery } from "@tanstack/react-query";

export type Coach = { id: number; name: string; color: string };

/**
 * Fetches the public list of lesson-giving coaches for this tenant.
 * Returns [] while loading or on error so callers can treat 0 or 1 coach as
 * the solo-coach path (no picker).
 */
export function useCoaches(): { coaches: Coach[]; isLoading: boolean } {
  const { data, isLoading } = useQuery<Coach[]>({
    queryKey: ["/api/coaches"],
    staleTime: 60_000,
  });
  return { coaches: data ?? [], isLoading };
}
