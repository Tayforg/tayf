import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiError,
  apiNotFound,
  apiServerError,
  apiUnauthorized,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { hasAdminSession } from "@/lib/admin/session";
import {
  isBiasCategory,
  isSourceKindValue,
  isValidIsoDate,
  isValidRater,
  isValidSourceName,
  isValidSourceSlug,
  isValidSourceUrl,
  isValidTrusteeNote,
  isValidZoneChangeReason,
  isValidZoneRationale,
} from "@/lib/validation/source-input";

// Mutating admin actions: 20-token bucket, refilling at 0.2 tokens/sec
// (1 token every 5s). Bursts of ~20 are fine, sustained spam gets 429'd.
// GET (read-only stats) is intentionally NOT limited because the admin UI
// polls it.
const adminPostLimit = createRateLimiter("admin-post", {
  capacity: 20,
  refillPerSecond: 0.2,
});

export const GET = withApiErrors(async () => {
  // Real auth boundary for admin data. The /admin page also calls
  // requireAdminSession(), but this route is the one a malicious client
  // could hit directly — so don't rely on the page gate.
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const supabase = createServerClient();

  const [
    { count: articleCount },
    { count: sourceCount },
    { count: clusterCount },
    { count: noImageCount },
  ] = await Promise.all([
    supabase.from("articles").select("*", { count: "exact", head: true }),
    supabase.from("sources").select("*", { count: "exact", head: true }),
    supabase.from("clusters").select("*", { count: "exact", head: true }),
    supabase
      .from("articles")
      .select("*", { count: "exact", head: true })
      .is("image_url", null),
  ]);

  const { data: sourcesList } = await supabase
    .from("sources")
    .select("id, name, slug, url, rss_url, bias, active")
    .order("bias");

  return NextResponse.json({
    articles: articleCount ?? 0,
    sources: sourceCount ?? 0,
    clusters: clusterCount ?? 0,
    missingImages: noImageCount ?? 0,
    sourcesList: sourcesList ?? [],
  });
});

export const POST = withApiErrors(async (request: Request) => {
  if (!(await hasAdminSession())) {
    return apiUnauthorized();
  }

  const rl = adminPostLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  const body = await request.json();
  const { action } = body;
  const supabase = createServerClient();

  switch (action) {
    case "nuke_articles": {
      const { error: caError } = await supabase.from("cluster_articles").delete().gte("cluster_id", "00000000-0000-0000-0000-000000000000");
      if (caError) return apiServerError(caError);
      const { error: clError } = await supabase.from("clusters").delete().gte("id", "00000000-0000-0000-0000-000000000000");
      if (clError) return apiServerError(clError);
      const { error: arError } = await supabase.from("articles").delete().gte("id", "00000000-0000-0000-0000-000000000000");
      if (arError) return apiServerError(arError);
      return NextResponse.json({ success: true, message: "All articles and clusters deleted" });
    }

    case "nuke_clusters": {
      const { error: caError } = await supabase.from("cluster_articles").delete().gte("cluster_id", "00000000-0000-0000-0000-000000000000");
      if (caError) return apiServerError(caError);
      const { error: clError } = await supabase.from("clusters").delete().gte("id", "00000000-0000-0000-0000-000000000000");
      if (clError) return apiServerError(clError);
      return NextResponse.json({ success: true, message: "All clusters deleted" });
    }

    case "toggle_source": {
      const { slug, active } = body;
      if (!isValidSourceSlug(slug) || typeof active !== "boolean") {
        return apiBadRequest("Invalid source or state");
      }
      const { error } = await supabase
        .from("sources")
        .update({ active })
        .eq("slug", slug);
      if (error) return apiServerError(error);
      return NextResponse.json({ success: true, message: `${slug} is now ${active ? "active" : "disabled"}` });
    }

    case "add_source": {
      const { name, slug, url, rss_url, bias, kind } = body;
      if (!name || !slug || !url || !rss_url || !bias) {
        return apiBadRequest("All fields are required");
      }
      if (!isValidSourceName(name)) return apiBadRequest("Invalid name");
      if (!isValidSourceSlug(slug)) return apiBadRequest("Invalid slug");
      if (!isValidSourceUrl(url)) return apiBadRequest("Invalid url");
      if (!isValidSourceUrl(rss_url)) return apiBadRequest("Invalid rss_url");
      if (!isBiasCategory(bias)) return apiBadRequest("Invalid bias");
      if (kind !== undefined && !isSourceKindValue(kind)) {
        return apiBadRequest("Invalid kind");
      }

      const insertPayload: Record<string, unknown> = {
        name,
        slug,
        url,
        rss_url,
        bias,
        active: true,
      };
      // The `kind` column is `not null default 'outlet'` (migration 034),
      // so omitting the key when the caller didn't provide one is correct
      // — the DB default applies rather than us writing an explicit value.
      if (kind !== undefined) insertPayload.kind = kind;

      const { error } = await supabase.from("sources").insert(insertPayload);
      if (error) return apiServerError(error);
      return NextResponse.json({ success: true, message: `${name} added` });
    }

    case "update_source": {
      const { id, name, slug, url, rss_url, bias, kind, active } = body;
      if (!id) return apiBadRequest("Source id is required");
      const updates: Record<string, unknown> = {};
      if (name !== undefined) {
        if (!isValidSourceName(name)) return apiBadRequest("Invalid name");
        updates.name = name;
      }
      if (slug !== undefined) {
        if (!isValidSourceSlug(slug)) return apiBadRequest("Invalid slug");
        updates.slug = slug;
      }
      if (url !== undefined) {
        if (!isValidSourceUrl(url)) return apiBadRequest("Invalid url");
        updates.url = url;
      }
      if (rss_url !== undefined) {
        if (!isValidSourceUrl(rss_url)) return apiBadRequest("Invalid rss_url");
        updates.rss_url = rss_url;
      }
      // Bias changes go through set_source_bias ONLY, never this action
      // (B55-REASONLESS-BIAS-PATH) -- update_source must never silently
      // relabel a source. If the payload's bias matches the current row,
      // it's a harmless no-op re-send from the client: drop it from the
      // update rather than erroring.
      if (bias !== undefined) {
        if (!isBiasCategory(bias)) return apiBadRequest("Invalid bias");
        const { data: currentSource, error: fetchError } = await supabase
          .from("sources")
          .select("bias")
          .eq("id", id)
          .maybeSingle();
        if (fetchError) return apiServerError(fetchError);
        if (currentSource && currentSource.bias !== bias) {
          return apiBadRequest(
            "Bias changes go through set_source_bias with a reason",
          );
        }
      }
      if (kind !== undefined) {
        if (!isSourceKindValue(kind)) return apiBadRequest("Invalid kind");
        updates.kind = kind;
      }
      if (active !== undefined) updates.active = active;
      if (Object.keys(updates).length === 0) return apiBadRequest("No fields to update");
      const { error } = await supabase.from("sources").update(updates).eq("id", id);
      if (error) return apiServerError(error);
      return NextResponse.json({ success: true, message: `${name || "Source"} updated` });
    }

    // Per-source rights flags (BL-13). Operator-only toggle for outlets that
    // have asked not to have their photos or excerpted text used — the two
    // columns are consumed read-side by the image and excerpt gates (owned
    // by a separate pack), not by this route. Only `image_allowed` /
    // `excerpt_allowed` may ever be written here; nothing else on `sources`
    // is reachable through this action.
    case "set_source_rights": {
      const { slug, image_allowed, excerpt_allowed } = body;
      if (!isValidSourceSlug(slug)) return apiBadRequest("Invalid slug");

      const updates: Record<string, boolean> = {};
      if (image_allowed !== undefined) {
        if (typeof image_allowed !== "boolean") {
          return apiBadRequest("image_allowed must be a boolean");
        }
        updates.image_allowed = image_allowed;
      }
      if (excerpt_allowed !== undefined) {
        if (typeof excerpt_allowed !== "boolean") {
          return apiBadRequest("excerpt_allowed must be a boolean");
        }
        updates.excerpt_allowed = excerpt_allowed;
      }
      if (Object.keys(updates).length === 0) {
        return apiBadRequest("image_allowed or excerpt_allowed is required");
      }

      const { data, error } = await supabase
        .from("sources")
        .update(updates)
        .eq("slug", slug)
        .select("slug, image_allowed, excerpt_allowed")
        .maybeSingle();
      if (error) return apiServerError(error);
      if (!data) return apiNotFound("Source not found");

      return NextResponse.json({
        slug: data.slug,
        image_allowed: data.image_allowed,
        excerpt_allowed: data.excerpt_allowed,
      });
    }

    // Zone-registry rationale + trusteeship fields (S-20/M-04, migration
    // 055). Operator-only. ONLY these four columns may ever be written by
    // this action -- nothing else on `sources` is reachable through it,
    // same discipline as `set_source_rights` above.
    case "set_source_registry": {
      const { slug, rationale, trustee_since, trustee_note } = body;
      if (!isValidSourceSlug(slug)) return apiBadRequest("Invalid slug");

      if (
        rationale === undefined &&
        trustee_since === undefined &&
        trustee_note === undefined
      ) {
        return apiBadRequest(
          "rationale, trustee_since or trustee_note is required",
        );
      }

      const updates: Record<string, string | null> = {};
      if (rationale !== undefined) {
        if (rationale !== null && !isValidZoneRationale(rationale)) {
          return apiBadRequest("rationale must be 1..1000 chars, or null to clear");
        }
        updates.zone_rationale = rationale === null ? null : rationale.trim();
        updates.zone_rationale_at =
          rationale === null ? null : new Date().toISOString();
      }
      if (trustee_since !== undefined) {
        if (trustee_since !== null && !isValidIsoDate(trustee_since)) {
          return apiBadRequest("trustee_since must be an ISO yyyy-mm-dd date, or null");
        }
        updates.trustee_since = trustee_since;
      }
      if (trustee_note !== undefined) {
        if (trustee_note !== null && !isValidTrusteeNote(trustee_note)) {
          return apiBadRequest("trustee_note must be 1..500 chars, or null");
        }
        updates.trustee_note = trustee_note === null ? null : trustee_note.trim();
      }

      // Trustee pairing invariant (B-SEC-03): trustee_since can never end
      // up non-null while trustee_note is null on the row -- an undated
      // kayyum flag is a new error, not a fact. A retraction passes
      // trustee_since: null together with a non-empty trustee_note (a
      // dated retraction text); nulling both is also fine. When the
      // request only touches one of the two columns, fetch the current
      // row to check the *merged* result, not just the request in
      // isolation.
      if (trustee_since !== undefined || trustee_note !== undefined) {
        let mergedTrusteeSince = trustee_since;
        let mergedTrusteeNote = trustee_note;
        if (trustee_since === undefined || trustee_note === undefined) {
          const { data: currentSource, error: fetchError } = await supabase
            .from("sources")
            .select("trustee_since, trustee_note")
            .eq("slug", slug)
            .maybeSingle();
          if (fetchError) return apiServerError(fetchError);
          if (trustee_since === undefined) {
            mergedTrusteeSince = currentSource?.trustee_since ?? null;
          }
          if (trustee_note === undefined) {
            mergedTrusteeNote = currentSource?.trustee_note ?? null;
          }
        }
        if (mergedTrusteeSince !== null && mergedTrusteeNote === null) {
          return apiBadRequest(
            "trustee_since requires a non-null trustee_note; a retraction clears trustee_since and keeps a dated note",
          );
        }
      }

      const { data, error } = await supabase
        .from("sources")
        .update(updates)
        .eq("slug", slug)
        .select("slug, zone_rationale, zone_rationale_at, trustee_since, trustee_note")
        .maybeSingle();
      if (error) return apiServerError(error);
      if (!data) return apiNotFound("Source not found");

      // So the cached /source/[slug] profile and the /api/sources registry
      // (both tagged "sources") reflect the change instead of serving a
      // retracted or stale label for up to an hour.
      revalidateTag("sources", "max");

      return NextResponse.json({
        slug: data.slug,
        zone_rationale: data.zone_rationale,
        zone_rationale_at: data.zone_rationale_at,
        trustee_since: data.trustee_since,
        trustee_note: data.trustee_note,
      });
    }

    // Bias changes go through the set_source_bias RPC ONLY -- never a
    // direct `.update({ bias })` -- so the audit trigger's transaction-
    // local reason/rater GUCs (migration 055) are always populated. Do NOT
    // replace this with two client-side writes; see pack.md's risk
    // register and the guard test in tests/api/admin.test.ts.
    case "set_source_bias": {
      const { slug, bias, reason, rater } = body;
      if (!isValidSourceSlug(slug)) return apiBadRequest("Invalid slug");
      if (!isBiasCategory(bias)) return apiBadRequest("Invalid bias");
      // A bias change can never be recorded without a stated reason.
      if (!isValidZoneChangeReason(reason)) {
        return apiBadRequest("reason must be 10..500 chars");
      }
      if (rater !== undefined && !isValidRater(rater)) {
        return apiBadRequest("rater must be a known role handle, not a person");
      }

      const { data, error } = await supabase.rpc("set_source_bias", {
        p_slug: slug,
        p_bias: bias,
        p_reason: reason.trim(),
        p_rater: rater ?? "tayf-admin",
      });
      if (error) {
        // Map the RPC's SQLSTATEs (migration 055) to the right HTTP status
        // instead of flattening every failure to a generic 500
        // (B55-RPC-ERRCODE-MAPPING / B-SEC-07).
        switch (error.code) {
          case "23514":
            return apiBadRequest(error.message);
          case "P0002":
            return apiNotFound("Source not found");
          case "P0003":
            return apiError(409, "Bias unchanged");
          case "restrict_violation":
          case "55000":
            return apiServerError(error);
          default:
            return apiServerError(error);
        }
      }

      revalidateTag("sources", "max");

      return NextResponse.json(data);
    }

    // SEC-07 follow-up: reset the kap-ingest circuit breaker (migration
    // 059's kap_fetch_state, single row id=1) — no body fields to
    // validate; a full reset (blocked_until, last_status, last_error all
    // null) so the badge goes back to a clean "closed" state, not just
    // unblocked with a stale last_error still showing.
    case "clear_kap_breaker": {
      const { error } = await supabase
        .from("kap_fetch_state")
        .update({ blocked_until: null, last_status: null, last_error: null, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) return apiServerError(error);
      return NextResponse.json({ success: true, message: "KAP devre kesici temizlendi" });
    }

    case "delete_source": {
      const { id } = body;
      if (!id) return apiBadRequest("Source id is required");
      const { error } = await supabase.from("sources").delete().eq("id", id);
      if (error) return apiServerError(error);
      return NextResponse.json({ success: true, message: "Source deleted" });
    }

    default:
      return apiBadRequest("Unknown action");
  }
});
