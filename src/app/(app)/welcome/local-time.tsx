"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** A time in the viewer's own timezone. The server doesn't know it, so it renders UTC until the browser takes over. */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    noop,
    () => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
    () => new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }),
  );
  return <time dateTime={iso}>{text}</time>;
}
