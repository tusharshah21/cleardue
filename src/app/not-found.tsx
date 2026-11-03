import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">This link may be out of date, or the invoice was replaced by a payment plan.</p>
      <Link href="/" className={buttonVariants({ variant: "outline" })}>
        Go to ClearDue
      </Link>
    </div>
  );
}
