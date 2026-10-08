import { notFound } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { views } from "@/components/navigation";
export const dynamicParams = false;
export const generateStaticParams = () =>
  views.map(([section]) => ({ section }));
export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const view = views.find(([v]) => v === section)?.[0];
  if (!view) notFound();
  return <Dashboard initialView={view} />;
}
