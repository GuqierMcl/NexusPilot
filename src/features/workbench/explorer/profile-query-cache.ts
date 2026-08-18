import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";

export async function clearProfileQueryCache(
    queryClient: QueryClient,
    profileId: string,
): Promise<void> {
    const queryKey = queryKeys.profile(profileId);
    await queryClient.cancelQueries({ queryKey });
    queryClient.removeQueries({ queryKey });
}
