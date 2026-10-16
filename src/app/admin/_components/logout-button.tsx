"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ADMIN_API, adminFetch } from "./api-client";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick() {
    setLoading(true);
    try {
      await adminFetch(ADMIN_API.logout, { method: "POST", csrf: true });
      router.push("/connexion");
      router.refresh();
    } catch {
      toast.error("Déconnexion impossible. Réessayez.");
      setLoading(false);
    }
  }

  // 44 px target; on a phone the icon alone shows (the header row is full), the name stays.
  return (
    <Button type="button" variant="ghost" size="sm" loading={loading} onClick={onClick} className="h-11 min-w-11 max-sm:px-0">
      <LogOut aria-hidden="true" />
      <span className="max-sm:sr-only">Se déconnecter</span>
    </Button>
  );
}
