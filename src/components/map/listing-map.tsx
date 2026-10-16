"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { addProtocol, Map as MapLibreMap, NavigationControl, setWorkerUrl } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { MOROCCO_BBOX } from "@/config/regions";
import { buildHouseStyle, MAP_ZOOM, MAPLIBRE_WORKER_URL } from "@/lib/map/style";
import { supportsWebGL2 } from "@/lib/map/webgl";
import { cn } from "@/lib/utils";

// Interactive map island (D10): loaded through next/dynamic({ ssr: false }) from MapToggle, never in the
// initial bundle (~430 KB gzip of JS). The worker is served from our origin (CSP worker-src 'self') and
// the PMTiles archive is read with Range requests through the pmtiles protocol. No exact marker: only the
// approximate area at the same offset position as the static map.

/** Control labels, translated by the caller (MapLibre's defaults are English). */
export interface ListingMapLabels {
  zoomIn: string;
  zoomOut: string;
  scrollHint: string;
  scrollHintMac: string;
  touchHint: string;
}

export interface ListingMapProps {
  /** Approximate position (approximatePosition(city, seed)), never the real point. */
  center: { lng: number; lat: number };
  pmtilesUrl: string;
  /** Plain-text attribution from publicConfig.map. */
  attribution: string;
  labels: ListingMapLabels;
  /** Accessible name of the map region. */
  description: string;
  /** Fired once after the first full render. */
  onReady?: () => void;
  /** Fired once when the map cannot be shown (no WebGL2, style or archive failure). */
  onUnavailable?: () => void;
  className?: string;
}

let protocolRegistered = false;

export default function ListingMap({ center, pmtilesUrl, attribution, labels, description, onReady, onUnavailable, className }: ListingMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const { lng, lat } = center;
  // Latest callbacks and labels without recreating the map.
  const latest = useRef({ onReady, onUnavailable, labels });
  useEffect(() => {
    latest.current = { onReady, onUnavailable, labels };
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (!supportsWebGL2()) {
      latest.current.onUnavailable?.();
      return;
    }
    setWorkerUrl(MAPLIBRE_WORKER_URL);
    if (!protocolRegistered) {
      addProtocol("pmtiles", new Protocol().tile);
      protocolRegistered = true;
    }
    const { labels: l } = latest.current;
    let loaded = false;
    let failed = false;
    const map = new MapLibreMap({
      container: element,
      style: buildHouseStyle(pmtilesUrl, { attribution, approx: { lng, lat } }),
      center: [lng, lat],
      zoom: MAP_ZOOM.listing,
      minZoom: MAP_ZOOM.min,
      maxZoom: MAP_ZOOM.max,
      maxBounds: [
        [MOROCCO_BBOX.west, MOROCCO_BBOX.south],
        [MOROCCO_BBOX.east, MOROCCO_BBOX.north],
      ],
      attributionControl: { compact: false },
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      cooperativeGestures: true,
      fadeDuration: 0,
      locale: {
        "NavigationControl.ZoomIn": l.zoomIn,
        "NavigationControl.ZoomOut": l.zoomOut,
        "CooperativeGesturesHandler.WindowsHelpText": l.scrollHint,
        "CooperativeGesturesHandler.MacHelpText": l.scrollHintMac,
        "CooperativeGesturesHandler.MobileHelpText": l.touchHint,
      },
    });
    map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), "top-right");
    map.once("load", () => {
      loaded = true;
      latest.current.onReady?.();
    });
    // A failure before the first render (archive unreachable, style rejected) hands back to the static
    // map; a single tile error afterwards is not worth a fallback.
    map.on("error", (event) => {
      if (loaded || failed) return;
      failed = true;
      console.warn("map unavailable", event.error?.message ?? "unknown error");
      latest.current.onUnavailable?.();
    });
    return () => {
      map.remove();
    };
  }, [lng, lat, pmtilesUrl, attribution]);

  return <div ref={container} data-testid="listing-map" role="region" aria-label={description} className={cn("h-full w-full", className)} />;
}
