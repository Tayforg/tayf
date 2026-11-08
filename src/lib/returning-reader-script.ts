import { LAST_VISIT_KEY } from "@/lib/last-visit";

/**
 * Inline script for the first position in <body> (src/app/layout.tsx). It runs
 * before the feed is parsed and, when this browser holds a last-visit stamp,
 * puts `data-rv` ("returning visitor") on <html>. globals.css keys the
 * reservation of the home "N yeni haber" pill's slot off that attribute
 * (`html[data-rv] [data-new-pill-slot][data-reserve]`, where `data-reserve` is
 * the component's server-decided "this render shows clusters"), so the slot is
 * already 26 px tall at first paint and filling it after hydration moves
 * nothing (h68-lcp-1). The script only runs at document parse; NewSinceLastVisit
 * sets the same attribute in a layout effect for a soft navigation to "/" that
 * mounts it after another tab wrote the stamp.
 *
 * The page stays cacheable: the server HTML is identical for every reader; only
 * the reader's own browser adds the attribute. It reads the very key
 * NewSinceLastVisit reads, and a blocked localStorage (private mode, disabled
 * storage) just leaves the attribute off, like a first visit. The string holds
 * no "<", so it cannot end its own <script> element.
 */
export const RETURNING_READER_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  LAST_VISIT_KEY,
)}))document.documentElement.setAttribute("data-rv","")}catch(e){}`;
