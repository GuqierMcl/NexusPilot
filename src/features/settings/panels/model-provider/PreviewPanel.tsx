import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";

export function PreviewPanel() {
    return (
        <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-3">
                <Skeleton className="h-4 w-28" />
                <ItemGroup className="gap-1.5 p-2">
                    {[0, 1, 2].map((index) => (
                        <Item
                            key={index}
                            variant="default"
                            className="border-border/60 bg-background"
                        >
                            <ItemMedia>
                                <Skeleton className="size-8 rounded-full" />
                            </ItemMedia>
                            <ItemContent>
                                <Skeleton
                                    className={
                                        index === 1 ? "h-4 w-28" : "h-4 w-24"
                                    }
                                />
                            </ItemContent>
                            <ItemActions>
                                <Skeleton className="h-8 w-20" />
                            </ItemActions>
                        </Item>
                    ))}
                </ItemGroup>
            </section>

            <section className="flex flex-col gap-3">
                <Skeleton className="h-4 w-24" />
                <ItemGroup className="gap-1.5 p-2">
                    {[0, 1].map((index) => (
                        <Item
                            key={index}
                            variant="default"
                            className="border-border/60 bg-background"
                        >
                            <ItemMedia>
                                <Skeleton className="size-8 rounded-full" />
                            </ItemMedia>
                            <ItemContent>
                                <Skeleton className="h-4 w-28" />
                                <Skeleton
                                    className={
                                        index === 0 ? "h-3 w-40" : "h-3 w-32"
                                    }
                                />
                            </ItemContent>
                            <ItemActions>
                                <Skeleton className="h-8 w-16" />
                            </ItemActions>
                        </Item>
                    ))}
                </ItemGroup>
            </section>
        </div>
    );
}
