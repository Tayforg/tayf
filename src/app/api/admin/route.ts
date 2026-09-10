import { NextResponse } from "next/server";
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
  isValidSourceName,
  isValidSourceSlug,
  isValidSourceUrl,
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
      await supabase.from("cluster_articles").delete().gte("cluster_id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("clusters").delete().gte("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("articles").delete().gte("id", "00000000-0000-0000-0000-000000000000");
      return NextResponse.json({ success: true, message: "All articles and clusters deleted" });
    }

    case "nuke_clusters": {
      await supabase.from("cluster_articles").delete().gte("cluster_id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("clusters").delete().gte("id", "00000000-0000-0000-0000-000000000000");
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
      if (bias !== undefined) {
        if (!isBiasCategory(bias)) return apiBadRequest("Invalid bias");
        updates.bias = bias;
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
