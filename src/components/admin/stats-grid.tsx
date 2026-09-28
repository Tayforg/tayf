import { StatCard } from "./stat-card";
import { Newspaper, Building2, Layers, ImageOff } from "lucide-react";

const items = [
  { icon: Newspaper, label: "Haberler", key: "articles" as const, approx: true },
  { icon: Building2, label: "Kaynaklar", key: "sources" as const, approx: false },
  { icon: Layers, label: "Kümeler", key: "clusters" as const, approx: true },
  { icon: ImageOff, label: "Görselsiz", key: "missingImages" as const, approx: true },
] as const;

export function StatsGrid({
  articles,
  sources,
  clusters,
  missingImages,
}: {
  articles: number;
  sources: number;
  clusters: number;
  missingImages: number;
}) {
  const values = { articles, sources, clusters, missingImages };

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {items.map((item, i) => (
        <div key={item.key} className={`stagger-${i + 1}`}>
          <StatCard
            icon={item.icon}
            label={item.label}
            value={values[item.key]}
            variant={item.key === "missingImages" && values[item.key] ? "warning" : "default"}
          />
        </div>
      ))}
    </div>
  );
}
