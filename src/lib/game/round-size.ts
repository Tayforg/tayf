// How many headlines /oyun plays and hands out. A plain module on purpose: the
// "use client" game imports these, and headline-pool.ts (next/cache, the
// server Supabase client, an inline "use cache" function) must never enter the
// client graph, or `next build` fails. tests/guards/public-client-weight.test.ts
// (R3) enforces it. No imports here, keep it that way.

/** Headlines in one Bölge round (the 60-second game). */
export const GAME_ROUND_SIZE = 10;
/** Headlines /oyun hands the client per page load: three rounds' worth, so
 * "Yeniden Oyna" can show 10 headlines the player has not answered yet. */
export const GAME_SESSION_SIZE = 30;
