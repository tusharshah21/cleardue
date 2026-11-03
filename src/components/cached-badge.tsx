import { Badge } from "@/components/ui/badge";

/** Shown wherever a stored result from an earlier live AI call was reused instead of calling the model again. */
export function CachedBadge() {
  return (
    <Badge variant="outline" className="border-sky-400 text-sky-700" title="An identical request was answered live earlier; that result was reused to stay within the AI quota">
      Cached result from an earlier live run
    </Badge>
  );
}
