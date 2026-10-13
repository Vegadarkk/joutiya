"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function ToastDemo() {
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="outline" onClick={() => toast.success("Annonce enregistrée")}>
        Succès
      </Button>
      <Button variant="outline" onClick={() => toast.error("L'envoi de la photo a échoué. Réessayez avec une image de moins de 10 Mo.")}>
        Erreur
      </Button>
      <Button variant="outline" onClick={() => toast("Brouillon enregistré", { action: { label: "Annuler", onClick: () => undefined } })}>
        Avec action
      </Button>
    </div>
  );
}

export function FieldDemo() {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (title.length < 5) {
      setError("Le titre doit faire au moins 5 caractères.");
      return;
    }
    setError(undefined);
    setPending(true);
    setTimeout(() => {
      setPending(false);
      toast.success("Titre validé");
    }, 900);
  }
  return (
    <form onSubmit={submit} noValidate className="flex max-w-md flex-col gap-4">
      <Field label="Titre de l'annonce" hint="Ex. : iPhone 13, 128 Go, très bon état" error={error} required>
        <Input name="title" maxLength={70} />
      </Field>
      <Button type="submit" loading={pending} className="w-fit">
        Valider le titre
      </Button>
    </form>
  );
}
