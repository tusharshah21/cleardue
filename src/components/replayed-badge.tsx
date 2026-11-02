import { Badge } from "@/components/ui/badge";

/** Shown wherever DEMO_MODE served a recorded AI response, so a replay is never passed off as a live call. */
export function ReplayedBadge() {
  return (
    <Badge variant="outline" className="border-amber-400 text-amber-700" title="DEMO_MODE served a recorded AI response instead of calling the model">
      replayed response
    </Badge>
  );
}
