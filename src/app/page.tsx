import { redirect } from "next/navigation";
import { views } from "@/components/navigation";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const old = await searchParams;
  const view = views.find(([v]) => v === old.view)?.[0] ?? "fleet";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(old))
    if (key !== "view" && typeof value === "string")
      params.set(key === "log" ? "selected" : key, value);
  redirect(`/${view}${params.size ? `?${params}` : ""}`);
}
