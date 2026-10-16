"use client";

import { useEffect, useState, type ComponentType } from "react";

// On-demand components loaded with next/dynamic (outside the root layouts' lazy islands). A chunk
// that cannot be downloaded would throw into the segment's error view, and next/dynamic keeps the
// first result of its loader for the page's life. So a failed download resolves to a stand-in that
// tries the download again each time it mounts (a dropped connection may be back) and renders the
// component once it arrives; `Fallback` shows while it keeps failing (a tab older than a redeploy
// asks for a chunk the new image no longer has: only a reload helps).

type Retried<P> = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; Component: ComponentType<P> };

/** next/dynamic loader of `load`, with a retrying stand-in when its chunk cannot be downloaded. */
export function loadWithRetry<P extends object>(load: () => Promise<ComponentType<P>>, Fallback: ComponentType<P>): () => Promise<ComponentType<P>> {
  function Retry(props: P) {
    const [state, setState] = useState<Retried<P>>({ kind: "loading" });
    useEffect(() => {
      let live = true;
      load().then(
        (Component) => {
          if (live) setState({ kind: "ready", Component });
        },
        () => {
          if (live) setState({ kind: "failed" });
        },
      );
      return () => {
        live = false;
      };
    }, []);
    if (state.kind === "ready") return <state.Component {...props} />;
    return state.kind === "failed" ? <Fallback {...props} /> : null;
  }
  return () => load().catch(() => Retry);
}
